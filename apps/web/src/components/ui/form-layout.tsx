import { ArrowLeft } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { Children, type ReactNode } from 'react';

import { ModuleBadge } from '@/components/shell/module-theme';
import { cn } from '@/lib/utils';

import { Button } from './button';

/*
 * §8/§12 form rules:
 *   - single column up to 8 fields, two columns beyond
 *   - modal for <=8 fields, full page otherwise (the caller decides the shell;
 *     this component decides the column count from the same threshold)
 *   - disabled submit while pending
 *   - buttons name the action: "Save changes", not "Submit" (§9)
 */
const SINGLE_COLUMN_MAX_FIELDS = 8;

export interface FormLayoutProps {
  children: ReactNode;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCancel?: () => void;
  /** Names the action, and the success toast should use the same verb (§9). */
  submitLabel?: string;
  cancelLabel?: string;
  isPending?: boolean;
  /**
   * Holds the submit closed while the form is knowingly incomplete.
   *
   * Separate from isPending, which means "working": this means "not yet a
   * valid thing to send", and the two look different to a user.
   */
  submitDisabled?: boolean;
  /** A whole-form error, distinct from the per-field errors (§12). */
  error?: string | undefined;
  /** Overrides the field-count heuristic when a layout needs it. */
  columns?: 1 | 2;
}

export function FormLayout({
  children,
  onSubmit,
  onCancel,
  submitLabel = 'Save changes',
  cancelLabel = 'Cancel',
  isPending = false,
  submitDisabled = false,
  error,
  columns,
}: FormLayoutProps) {
  const fieldCount = Children.count(children);
  const columnCount = columns ?? (fieldCount > SINGLE_COLUMN_MAX_FIELDS ? 2 : 1);

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      {error !== undefined && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
          {error}
        </p>
      )}

      <div
        className={cn(
          'grid gap-4',
          columnCount === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1',
        )}
      >
        {children}
      </div>

      {/* On a phone the buttons run full width, the main action nearest the thumb. */}
      <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:items-center">
        <Button type="submit" disabled={isPending || submitDisabled} className="max-sm:w-full">
          {isPending ? 'Saving…' : submitLabel}
        </Button>
        {onCancel !== undefined && (
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={isPending}
            className="max-sm:w-full"
          >
            {cancelLabel}
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * The §8 list-screen header: the module's colour badge and the title on the
 * left, the permission-gated Add on the right. On a phone the action drops
 * below the title and runs full width.
 */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <ModuleBadge />
        <div className="min-w-0">
          <h1 className="text-page-title text-hull">{title}</h1>
          {description !== undefined && (
            <p className="mt-0.5 text-body text-steel">{description}</p>
          )}
        </div>
      </div>
      {action !== undefined && action !== null && action !== false && (
        <div className="flex flex-wrap items-center gap-2 max-sm:*:flex-1">{action}</div>
      )}
    </div>
  );
}

/**
 * The "Back to list" chip. Exported as classes rather than a component so a
 * screen can put it on whichever link it already uses (next/link with a typed
 * route, or a plain anchor) — pair it with an ArrowLeft icon at size-3.5.
 */
export const backLinkClasses =
  'inline-flex w-fit items-center gap-1.5 rounded-full bg-module-soft px-3 py-1 text-cell font-medium text-harbour transition-colors duration-[120ms] hover:bg-row-hover hover:text-harbour-ink';

/**
 * §8: every child screen is scoped to its parent by URL, shows the parent name,
 * and has a Back to list link. Required, not optional.
 */
export function ChildScreenHeader({
  parentLabel,
  parentName,
  title,
  backHref,
}: {
  parentLabel: string;
  parentName: string;
  title: string;
  backHref: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      {/* A Link, not an anchor: going back to the list should not reload the app. */}
      <Link href={backHref as Route} className={backLinkClasses}>
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Back to list
      </Link>
      <div className="flex min-w-0 items-start gap-3">
        <ModuleBadge />
        <div className="min-w-0">
          <p className="label-manifest">{parentLabel}</p>
          <h1 className="text-page-title break-words text-hull">{parentName}</h1>
          <p className="mt-0.5 text-body text-steel">{title}</p>
        </div>
      </div>
    </div>
  );
}
