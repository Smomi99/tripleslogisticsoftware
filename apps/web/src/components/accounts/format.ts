import type { DebitInvoiceDisplayStatus, PaymentStatus } from '@ff/shared';

import type { StatusTone } from '@/components/ui/status';

/**
 * Shared by the three Accounts screens (docs/MODULE_ACCOUNTS.md §8).
 *
 * Money arrives as decimal strings and is only ever formatted here, never
 * added up: every total on these screens is one the server computed.
 */

/** "1450.5" -> "1,450.50" — a column of money has to line up (CLAUDE.md §12). */
export function amount(value: string | null | undefined, dp = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** "USD 1,450.50", or a dash when there is nothing to show. */
export function money(code: string | null | undefined, value: string | null | undefined): string {
  const shown = amount(value);
  return shown === '—' || code === null || code === undefined || code === '' ? shown : `${code} ${shown}`;
}

export const DISPLAY_STATUS_TONE: Record<DebitInvoiceDisplayStatus, StatusTone> = {
  DRAFT: 'pending',
  UNPAID: 'pending',
  PARTIAL: 'pending',
  PAID: 'active',
  CANCELLED: 'inactive',
};

export const PAYMENT_TONE: Record<PaymentStatus, StatusTone> = {
  UNPAID: 'pending',
  PARTIAL: 'pending',
  PAID: 'active',
};

/**
 * A grid row's amounts while it is being typed — a preview only. What is
 * saved is recomputed by Postgres (the line amount is a GENERATED column) and
 * the screen then shows the server's figures, not these.
 */
export function previewLine(
  quantity: string,
  unitPrice: string,
  rate: string,
): { amount: number | null; base: number | null } {
  const q = Number(quantity);
  const p = Number(unitPrice);
  const r = Number(rate);
  if (quantity.trim() === '' || unitPrice.trim() === '' || !Number.isFinite(q) || !Number.isFinite(p)) {
    return { amount: null, base: null };
  }
  const value = q * p;
  return { amount: value, base: Number.isFinite(r) && r > 0 ? value * r : null };
}

/** A number the preview produced, formatted like the rest. */
export function fmt(value: number | null): string {
  return value === null ? '—' : amount(String(value));
}
