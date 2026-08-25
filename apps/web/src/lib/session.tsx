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

import { ApiError, apiRequest, apiRequestWithMeta, type ApiResult } from './api-client';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

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
  authorizedRequest: <T>(path: string, init?: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown }) => Promise<T>;
  /** Same, but keeps the §9 `meta` a list screen needs for its pager. */
  authorizedList: <T>(path: string) => Promise<ApiResult<T>>;
  /**
   * Multipart upload. Cannot go through apiRequest, which serialises JSON —
   * but it must still carry the bearer token and the same refresh-and-retry,
   * which is why it lives here rather than in the calling screen.
   */
  authorizedUpload: <T>(path: string, file: File, fields?: Record<string, string>) => Promise<T>;
  /**
   * A bearer-authenticated image, as a URL an <img> can use.
   *
   * Same problem authorizedDownload solves and the same answer: a browser
   * loading an <img src> sends no Authorization header, so the bytes are
   * fetched and handed over as an object URL. The caller revokes it.
   */
  authorizedObjectUrl: (path: string) => Promise<string>;
  /**
   * Downloads a bearer-authenticated file. A plain link cannot do this — a
   * browser navigation carries no Authorization header — so the response is
   * fetched and handed to a temporary object URL.
   */
  authorizedDownload: (path: string, fileName: string) => Promise<void>;
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
      init?: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown },
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

  const authorizedUpload = useCallback(
    async <T,>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> =>
      withRefresh(async (token) => {
        const body = new FormData();
        body.append('file', file);
        // Alongside the file: a signature logo arrives with its alt text and
        // the height it should be sent at.
        for (const [key, value] of Object.entries(fields)) body.append(key, value);
        const response = await fetch(`${API_BASE}${path}`, {
          method: 'POST',
          credentials: 'include',
          // Content-Type is deliberately unset: the browser must add the
          // multipart boundary itself.
          headers: {
            'X-Tenant-Slug': tenantSlug,
            ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
          },
          body,
        });
        const payload = (await response.json()) as
          | { success: true; data: T }
          | { success: false; error: { code: string; message: string } };

        if (!payload.success) {
          throw new ApiError(response.status, payload.error.code, payload.error.message);
        }
        return payload.data;
      }),
    [withRefresh, tenantSlug],
  );

  const authorizedObjectUrl = useCallback(
    async (path: string): Promise<string> =>
      withRefresh(async (token) => {
        const response = await fetch(`${API_BASE}${path}`, {
          credentials: 'include',
          headers: {
            'X-Tenant-Slug': tenantSlug,
            ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (!response.ok) {
          throw new ApiError(response.status, 'FETCH_FAILED', 'Could not load that image.');
        }
        return URL.createObjectURL(await response.blob());
      }),
    [withRefresh, tenantSlug],
  );

  const authorizedDownload = useCallback(
    async (path: string, fileName: string): Promise<void> =>
      withRefresh(async (token) => {
        const response = await fetch(`${API_BASE}${path}`, {
          credentials: 'include',
          headers: {
            'X-Tenant-Slug': tenantSlug,
            ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (!response.ok) {
          throw new ApiError(response.status, 'DOWNLOAD_FAILED', 'Could not download that file.');
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      }),
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

      /*
       * The client-side mirror of the API's session gate, and it has to come
       * first.
       *
       * The API refuses an EXTERNAL session — agent, customer or vendor — on
       * every staff router whatever their role holds. A role is a list somebody
       * ticked, and ticking the wrong box must not widen an outside company.
       * The browser was not applying that rule: an agent whose role carried
       * every permission got a sidebar listing every module, and the shell
       * rendered each staff screen while the API quietly refused its data. No
       * records leaked, but the shape of the whole system did, and it looked
       * broken rather than closed.
       *
       * Above the superadmin branch on purpose. The database CHECK already makes
       * an agent superadmin unstorable; this makes it harmless even if it were.
       */
      if (user.isExternal) {
        // An agent reaches its own module. A customer or a vendor has no module
        // yet, so it reaches nothing — the account exists, and there is simply
        // no screen for it until one is built.
        return user.agentId !== null && permissionKey.startsWith('AGENT.');
      }

      // §7 rule 1: a superadmin holds everything, always.
      if (user.isSuperadmin) return true;
      return user.permissions.includes(permissionKey);
    },
    [user],
  );

  const value = useMemo<SessionValue>(
    () => ({ user, status, tenantSlug, signIn, signOut, authorizedRequest, authorizedList, authorizedUpload, authorizedObjectUrl, authorizedDownload, can }),
    [user, status, tenantSlug, signIn, signOut, authorizedRequest, authorizedList, authorizedUpload, authorizedObjectUrl, authorizedDownload, can],
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
