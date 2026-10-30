'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether a CSS media query matches, kept live as the window resizes.
 *
 * The server has no window, so it reports false — every screen that uses this
 * renders only after the session loads on the client, so the server value is
 * never what a user sees.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Below Tailwind's `md` (768px): a phone, where tables become cards. */
export function useIsPhone(): boolean {
  return useMediaQuery('(max-width: 767.98px)');
}
