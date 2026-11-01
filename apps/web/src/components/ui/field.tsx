import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { controlClasses } from './control';

/*
 * Form rules, all of them load-bearing:
 *   - labels sit ABOVE inputs, never beside or inside, in sentence case
 *   - required is marked on the label, never by placeholder
 *   - 36px inputs (40px on a phone), 8px radius, 1px --line; focus turns the
 *     border to the module colour with a soft ring around it
 *   - inputs are 16px on a phone: iOS zooms the page into anything smaller
 *   - errors sit below the field in --alert, and name the fix
 */

export interface FieldProps {
  id: string;
  label: string;
  required?: boolean;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
  /** Spans both columns in a two-column FormLayout. */
  wide?: boolean;
}

export function Field({ id, label, required, error, hint, children, wide }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', wide && 'md:col-span-2')}>
      <label htmlFor={id} className="label-field">
        {label}
        {required === true && (
          <span className="ml-1 text-alert" aria-hidden="true">
            *
          </span>
        )}
        {required === true && <span className="sr-only"> (required)</span>}
      </label>
      {children}
      {hint !== undefined && error === undefined && (
        <p className="text-cell text-steel">{hint}</p>
      )}
      {error !== undefined && (
        <p id={`${id}-error`} role="alert" className="text-cell text-alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * React 19 passes `ref` as an ordinary prop, so no forwardRef is needed — but
 * the prop type has to admit it, which InputHTMLAttributes alone does not.
 */
export interface InputProps extends ComponentPropsWithRef<'input'> {
  /** Identifiers and numbers render in mono with tabular figures (§12). */
  numeric?: boolean;
}

export function Input({ className, numeric, ...props }: InputProps) {
  return (
    <input
      className={cn(controlClasses, numeric === true && 'font-mono', className)}
      {...(numeric === true ? { 'data-numeric': '' } : {})}
      {...props}
    />
  );
}

/**
 * Every dropdown is the searchable one (client, 2026-11-01). It lives in its
 * own client module; it is exported here so the 200-odd screens that import
 * Select beside Field and Input keep their imports.
 */
export { Select, type SelectProps } from './select';
