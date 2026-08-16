import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

/*
 * §12 form rules, all of them load-bearing:
 *   - labels sit ABOVE inputs, never beside or inside
 *   - required is marked on the label, never by placeholder
 *   - 36px inputs, 4px radius, 1px --line, focus = 2px --harbour ring
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
      <label htmlFor={id} className="label-manifest">
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

const controlClasses = cn(
  'h-9 w-full rounded-manifest border border-line bg-surface px-2.5',
  'text-body text-hull transition-colors duration-[120ms] ease-manifest',
  'focus:outline-2 focus:outline-offset-0 focus:outline-harbour',
  'disabled:cursor-not-allowed disabled:bg-paper disabled:text-steel',
  'aria-[invalid=true]:border-alert',
);

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
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

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(controlClasses, 'pr-8', className)} {...props}>
      {children}
    </select>
  );
}
