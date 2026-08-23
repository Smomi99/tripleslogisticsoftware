'use client';

import type { PortalLoginResponse, PortalUser } from '@ff/shared';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { apiRequest, apiRequestWithMeta, type ApiResult } from './api-client';

/**
 * The agent portal's session (docs/AGENT_PORTAL_DESIGN.md §2.5).
 *
 * A separate provider from the staff one, not a mode of it. They talk to
 * different endpoints, carry different cookies, and describe different people —
 * and keeping them apart means a staff session and an agent session can sit in
 * one browser without either overwriting the other.
 *
 * The shape is deliberately smaller. There is no `can()` and no permission
 * list, because an agent holds neither: what they may reach is decided by the
 * portal's own routes and by row level security, not by §7's resolution order.
 * A provider that exposed `can()` would invite a screen to ask it, and get an
 * answer that means nothing.
 *
 * Like the staff session, the access token lives in memory only. Durability
 * comes from the httpOnly cookie, which is scoped to /api/portal/auth and is
 * therefore never sent to a staff endpoint at all.
 */

interface PortalSessionValue {
  user: PortalUser | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  tenantSlug: string;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  request: <T>(
    path: string,
    init?: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown },
  ) => Promise<T>;
  list: <T>(path: string) => Promise<ApiResult<T>>;
}

const PortalSessionContext = createContext<PortalSessionValue | null>(null);

export function PortalSessionProvider({
  children,
  tenantSlug,
}: {
  children: React.ReactNode;
  tenantSlug: string;
}) {
  const router = useRouter();
  const [user, setUser] = useState<PortalUser | null>(null);
  const [status, setStatus] = useState<PortalSessionValue['status']>('loading');
  // A ref, not state: the token must be readable by a request issued in the
  // same tick it was set, before React has re-rendered.
  const accessToken = useRef<string | null>(null);

  const refresh = useCallback(async (): Promise<string | null> => {
    try {
      const data = await apiRequest<{ accessToken: string }>('/api/portal/auth/refresh', {
        method: 'POST',
        tenantSlug,
      });
      accessToken.current = data.accessToken;
      return data.accessToken;
    } catch {
      accessToken.current = null;
      return null;
    }
  }, [tenantSlug]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const token = await refresh();
      if (!active) return;
      if (token === null) {
        setStatus('anonymous');
        return;
      }
      try {
        const me = await apiRequest<PortalUser>('/api/portal/auth/me', {
          tenantSlug,
          accessToken: token,
        });
        if (!active) return;
        setUser(me);
        setStatus('authenticated');
      } catch {
        if (active) setStatus('anonymous');
      }
    })();
    return () => {
      active = false;
    };
  }, [refresh, tenantSlug]);

  /** A 15-minute token expires mid-session constantly; the retry is normal. */
  const withRefresh = useCallback(
    async <T,>(send: (token: string | null) => Promise<T>): Promise<T> => {
      try {
        return await send(accessToken.current);
      } catch (error) {
        const isAuthFailure = error instanceof Error && 'status' in error && error.status === 401;
        if (!isAuthFailure) throw error;

        const token = await refresh();
        if (token === null) {
          setUser(null);
          setStatus('anonymous');
          throw error;
        }
        return send(token);
      }
    },
    [refresh],
  );

  const request = useCallback(
    async <T,>(
      path: string,
      init?: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown },
    ): Promise<T> =>
      withRefresh((token) =>
        apiRequest<T>(path, {
          tenantSlug,
          accessToken: token ?? undefined,
          ...(init?.method !== undefined ? { method: init.method } : {}),
          ...(init?.body !== undefined ? { body: init.body } : {}),
        }),
      ),
    [withRefresh, tenantSlug],
  );

  const list = useCallback(
    async <T,>(path: string): Promise<ApiResult<T>> =>
      withRefresh((token) =>
        apiRequestWithMeta<T>(path, { tenantSlug, accessToken: token ?? undefined }),
      ),
    [withRefresh, tenantSlug],
  );

  const signIn = useCallback(
    async (username: string, password: string) => {
      const data = await apiRequest<PortalLoginResponse>('/api/portal/auth/login', {
        method: 'POST',
        body: { username, password },
        tenantSlug,
      });
      accessToken.current = data.accessToken;
      setUser(data.user);
      setStatus('authenticated');
      router.push('/portal');
    },
    [router, tenantSlug],
  );

  const signOut = useCallback(async () => {
    try {
      await apiRequest('/api/portal/auth/logout', { method: 'POST', tenantSlug });
    } finally {
      accessToken.current = null;
      setUser(null);
      setStatus('anonymous');
      router.push('/portal/login');
    }
  }, [router, tenantSlug]);

  const value = useMemo<PortalSessionValue>(
    () => ({ user, status, tenantSlug, signIn, signOut, request, list }),
    [user, status, tenantSlug, signIn, signOut, request, list],
  );

  return (
    <PortalSessionContext.Provider value={value}>{children}</PortalSessionContext.Provider>
  );
}

export function usePortalSession(): PortalSessionValue {
  const context = useContext(PortalSessionContext);
  if (context === null) {
    throw new Error('usePortalSession must be used inside a PortalSessionProvider.');
  }
  return context;
}
