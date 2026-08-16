import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

/*
 * §12: actions are text buttons in --harbour, not icon-only — the users are not
 * power users on day one. Destructive and deactivate actions are --alert.
 * One radius, 120ms ease-out, visible focus ring.
 */
const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-manifest',
    'font-medium transition-colors duration-[120ms] ease-manifest',
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-harbour',
    'disabled:pointer-events-none disabled:opacity-50',
  ),
  {
    variants: {
      variant: {
        primary: 'bg-harbour text-white hover:bg-harbour-ink',
        secondary: 'border border-line bg-surface text-hull hover:bg-row-hover',
        /** The default for row actions (§12). */
        text: 'text-harbour hover:text-harbour-ink hover:underline underline-offset-2',
        destructive: 'text-alert hover:underline underline-offset-2',
        danger: 'bg-alert text-white hover:brightness-95',
      },
      size: {
        /** Matches the 36px input height so a button sits level with a field. */
        default: 'h-9 px-3 text-body',
        compact: 'h-8 px-2.5 text-cell',
        /** Text buttons carry no box, so they get no padding or height. */
        inline: 'h-auto p-0 text-cell',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      // A button inside a form defaults to submit, which is rarely what a row
      // action wants. Callers opt in explicitly.
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
