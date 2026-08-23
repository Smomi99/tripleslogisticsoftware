'use client';

import { cn } from '@/lib/utils';

/**
 * The frame every unauthenticated portal page sits in: sign in, accept an
 * invite, ask for a reset, choose a new password.
 *
 * §12 says empty states invite the action rather than shrugging. The same
 * applies to a door: an agent arriving from an email has no idea what this
 * system is, so the card says who it belongs to and what it is for before it
 * asks for anything.
 */
export function PortalDoor({
  title,
  lead,
  children,
  footer,
}: {
  title: string;
  lead?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper p-5">
      <div className="w-full max-w-sm rounded-manifest border border-line bg-surface p-6 shadow-manifest">
        <div className="mb-5">
          <span className="font-mono text-cell tracking-wider text-steel">RATE PORTAL</span>
          <h1 className="mt-2 text-page-title text-hull">{title}</h1>
          {lead !== undefined && <p className="mt-1.5 text-body text-steel">{lead}</p>}
        </div>
        {children}
        {footer !== undefined && (
          <div className="mt-5 border-t border-line pt-4 text-cell text-steel">{footer}</div>
        )}
      </div>
    </div>
  );
}

/** A message that stops the page: an expired link, a finished action. */
export function PortalNotice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'error' | 'done';
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={cn(
        'rounded-manifest border px-3 py-2 text-body',
        tone === 'error' && 'border-alert/30 bg-alert/5 text-alert',
        tone === 'done' && 'border-verified/30 bg-verified/5 text-verified',
        tone === 'info' && 'border-line bg-paper text-steel',
      )}
    >
      {children}
    </p>
  );
}
