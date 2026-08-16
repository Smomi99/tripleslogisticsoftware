import { Children, type ReactNode } from 'react';

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

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Saving…' : submitLabel}
        </Button>
        {onCancel !== undefined && (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={isPending}>
            {cancelLabel}
          </Button>
        )}
      </div>
    </form>
  );
}

/** The §8 list-screen header: title on the left, permission-gated Add on the right. */
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
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-page-title text-hull">{title}</h1>
        {description !== undefined && (
          <p className="mt-0.5 text-body text-steel">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

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
    <div className="flex flex-col gap-2">
      <a
        href={backHref}
        className="text-cell text-harbour hover:text-harbour-ink hover:underline underline-offset-2"
      >
        ← Back to list
      </a>
      <div>
        <p className="label-manifest">{parentLabel}</p>
        <h1 className="text-page-title text-hull">{parentName}</h1>
        <p className="mt-0.5 text-body text-steel">{title}</p>
      </div>
    </div>
  );
}
