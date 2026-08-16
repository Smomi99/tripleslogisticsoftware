'use client';

import type { AuthenticatedUser, LoginResponse } from '@ff/shared';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { apiRequest, apiRequestWithMeta, type ApiResult } from './api-client';

/**
 * Client session.
 *
 * The access token lives in memory only — never localStorage, where any script
 * on the page can read it. Durability comes from the httpOnly refresh cookie:
 * on mount the provider trades it for a fresh access token, so a reload
 * restores the session without the token ever touching disk.
 */

interface SessionValue {
  user: AuthenticatedUser | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  tenantSlug: string;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** For data calls — refreshes first if the token has expired. */
  authorizedRequest: <T>(path: string, init?: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT'; body?: unknown }) => Promise<T>;
  /** Same, but keeps the §9 `meta` a list screen needs for its pager. */
  authorizedList: <T>(path: string) => Promise<ApiResult<T>>;
  /** §7 enforcement layer 4: hide what the user cannot reach. */
  can: (permissionKey: string) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({
  children,
  tenantSlug,
}: {
  children: React.ReactNode;
  tenantSlug: string;
}) {
  const router = useRouter();
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [status, setStatus] = useState<SessionValue['status']>('loading');
  // A ref, not state: the token must be readable by a request issued in the
  // same tick it was set, before React has re-rendered.
  const accessToken = useRef<string | null>(null);

  const refresh = useCallback(async (): Promise<string | null> => {
    try {
      const data = await apiRequest<{ accessToken: string }>('/api/tenant/auth/refresh', {
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

  // Restore the session on first mount.
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
        const me = await apiRequest<AuthenticatedUser>('/api/tenant/auth/me', {
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

  /**
   * Runs a request, and on a 401 refreshes once and retries.
   *
   * A 15-minute access token expires mid-session constantly, so the retry is
   * the normal path, not an error path. Only a failed refresh ends the session.
   */
  const withRefresh = useCallback(
    async <T,>(send: (token: string | null) => Promise<T>): Promise<T> => {
      try {
        return await send(accessToken.current);
      } catch (error) {
        const isAuthFailure =
          error instanceof Error && 'status' in error && error.status === 401;
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

  const authorizedRequest = useCallback(
    async <T,>(
      path: string,
      init?: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT'; body?: unknown },
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

  const authorizedList = useCallback(
    async <T,>(path: string): Promise<ApiResult<T>> =>
      withRefresh((token) =>
        apiRequestWithMeta<T>(path, { tenantSlug, accessToken: token ?? undefined }),
      ),
    [withRefresh, tenantSlug],
  );

  const signIn = useCallback(
    async (username: string, password: string) => {
      const data = await apiRequest<LoginResponse>('/api/tenant/auth/login', {
        method: 'POST',
        body: { username, password },
        tenantSlug,
      });
      accessToken.current = data.accessToken;
      setUser(data.user);
      setStatus('authenticated');
      router.push('/');
    },
    [router, tenantSlug],
  );

  const signOut = useCallback(async () => {
    try {
      await apiRequest('/api/tenant/auth/logout', { method: 'POST', tenantSlug });
    } finally {
      accessToken.current = null;
      setUser(null);
      setStatus('anonymous');
      router.push('/login');
    }
  }, [router, tenantSlug]);

  const can = useCallback(
    (permissionKey: string): boolean => {
      if (user === null) return false;
      // §7 rule 1: a superadmin holds everything, always.
      if (user.isSuperadmin) return true;
      return user.permissions.includes(permissionKey);
    },
    [user],
  );

  const value = useMemo<SessionValue>(
    () => ({ user, status, tenantSlug, signIn, signOut, authorizedRequest, authorizedList, can }),
    [user, status, tenantSlug, signIn, signOut, authorizedRequest, authorizedList, can],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (context === null) {
    throw new Error('useSession must be used inside a SessionProvider.');
  }
  return context;
}
