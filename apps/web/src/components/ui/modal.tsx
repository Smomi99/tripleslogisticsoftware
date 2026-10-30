'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Button } from './button';

/*
 * §8: a form with 8 fields or fewer goes in a modal, more than 8 goes on a full
 * page.
 *
 *   phone     a sheet that rises from the bottom edge, full width, up to 92% of
 *             the screen tall, with a grab bar — reachable with one thumb.
 *   sm and up a centred dialog, 12px radius, raised shadow, 160ms entry.
 *
 * The title row sticks to the top while a long form scrolls beneath it, so
 * the close button is never scrolled away.
 *
 * Radix handles focus trapping, restoring focus on close, Escape, and the
 * aria wiring — all part of the keyboard-navigation quality floor.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  size = 'default',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /**
   * "wide" is for a form §8 would otherwise send to a full page. The client
   * asked for the inquiry form as a modal; at 32rem its seventeen fields would
   * be a single scrolling column, which is worse than the page it replaced.
   *
   * "medium" is for a dialog whose rows carry figures side by side — the Price
   * drawer's carrier, size, price and actions — and wrap at 32rem.
   */
  size?: 'default' | 'medium' | 'wide';
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-hull/50 animate-fade-in" />
        <Dialog.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] w-full overflow-y-auto',
            'rounded-t-[20px] bg-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-raised animate-sheet-up',
            'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[calc(100dvh-2rem)]',
            'sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card sm:border sm:border-line sm:px-5 sm:pb-5 sm:animate-dialog-in',
            size === 'wide'
              ? 'sm:w-[min(68rem,calc(100vw-2rem))]'
              : size === 'medium'
                ? 'sm:w-[min(44rem,calc(100vw-2rem))]'
                : 'sm:w-[min(32rem,calc(100vw-2rem))]',
          )}
        >
          <div className="sticky top-0 z-10 -mx-4 mb-4 border-b border-line bg-surface px-4 pb-3 pt-2 sm:-mx-5 sm:px-5 sm:pt-5">
            <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-line sm:hidden" />
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-2.5">
                <span aria-hidden="true" className="mt-1.5 h-4 w-1 shrink-0 rounded-full bg-linear-to-b from-module to-harbour" />
                <div className="min-w-0">
                  <Dialog.Title className="text-section text-hull">{title}</Dialog.Title>
                  {description !== undefined && (
                    <Dialog.Description className="mt-0.5 text-body text-steel">
                      {description}
                    </Dialog.Description>
                  )}
                </div>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="-mr-1 rounded-full p-2 text-steel transition-colors duration-[120ms] hover:bg-paper hover:text-hull sm:p-1.5"
                >
                  <X className="size-4" />
                </button>
              </Dialog.Close>
            </div>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * §12 quality floor: every destructive action confirms. Deactivation is the
 * only removal this product has (§4 rule 3), so it is what gets confirmed.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel,
  destructive = false,
  isPending = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  isPending?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <p className="text-body text-steel">{message}</p>
      <div className="mt-5 flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:items-center">
        <Button
          variant={destructive ? 'danger' : 'primary'}
          onClick={onConfirm}
          disabled={isPending}
          className="max-sm:w-full"
        >
          {isPending ? 'Working…' : confirmLabel}
        </Button>
        <Button
          variant="secondary"
          onClick={() => onOpenChange(false)}
          disabled={isPending}
          className="max-sm:w-full"
        >
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
