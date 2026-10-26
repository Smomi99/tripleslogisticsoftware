'use client';

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A figure that explains itself on hover — or on keyboard focus, so it is not
 * a mouse-only feature (§12 quality floor). What it shows is loaded the first
 * time it opens, and kept.
 *
 * The panel is rendered into document.body. Inside a dialog it would be
 * clipped by the dialog's scrolling and placed against its centring transform
 * rather than the viewport; inside a table, by the sticky columns. It is
 * display only — nothing in it takes a click — so it needs no pointer events
 * and no focus of its own, and closes on any scroll.
 */
export function HoverPanel<T>({
  title,
  load,
  render,
  children,
  width = 400,
}: {
  /** The panel's heading, e.g. "Price history · Evergreen Line · 20STD". */
  title: string;
  load: () => Promise<T>;
  render: (data: T) => ReactNode;
  children: ReactNode;
  width?: number;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const requested = useRef(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [data, setData] = useState<{ value: T } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();

  function show(): void {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setAnchor(rect);
    if (requested.current) return;
    requested.current = true;
    setError(null);
    load().then(
      (value) => setData({ value }),
      () => {
        // A later hover may try again; the message says so.
        requested.current = false;
        setError('Could not load this. Hover again to retry.');
      },
    );
  }

  const hide = (): void => setAnchor(null);

  useEffect(() => {
    if (anchor === null) return;
    // Capture, so a scroll inside a dialog or table is heard as well as the page's.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [anchor]);

  // Right edge on the figure's right edge, kept on screen; above the figure
  // when it sits in the lower part of the window, so the panel is not cut off.
  const position =
    anchor === null
      ? undefined
      : {
          left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
          ...(anchor.bottom > window.innerHeight * 0.6
            ? { bottom: window.innerHeight - anchor.top + 4 }
            : { top: anchor.bottom + 4 }),
        };

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        aria-describedby={anchor === null ? undefined : panelId}
        className="cursor-help rounded-manifest underline decoration-dotted decoration-steel underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-harbour"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {anchor !== null &&
        createPortal(
          <div
            id={panelId}
            role="tooltip"
            style={{ ...position, width }}
            className="pointer-events-none fixed z-60 rounded-manifest border border-line bg-surface p-3 text-left font-sans shadow-manifest"
          >
            <p className="label-manifest">{title}</p>
            {error !== null ? (
              <p className="mt-2 text-cell text-alert">{error}</p>
            ) : data === null ? (
              <p className="mt-2 text-cell text-steel">Loading…</p>
            ) : (
              <div className="mt-2">{render(data.value)}</div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
