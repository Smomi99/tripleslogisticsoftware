'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Button } from './button';

/*
 * §8: a form with 8 fields or fewer goes in a modal, more than 8 goes on a full
 * page. §12: 4px radius, the single shadow, 160ms entry, and nothing else.
 *
 * Radix handles focus trapping, restoring focus on close, Escape, and the
 * aria wiring — all part of §12's keyboard-navigation quality floor.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-40 bg-hull/40',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0',
          )}
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100vw-2rem))]',
            '-translate-x-1/2 -translate-y-1/2',
            'rounded-manifest border border-line bg-surface p-5 shadow-manifest',
            'max-h-[calc(100vh-2rem)] overflow-y-auto',
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-section text-hull">{title}</Dialog.Title>
              {description !== undefined && (
                <Dialog.Description className="mt-0.5 text-body text-steel">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="rounded-manifest p-1 text-steel transition-colors duration-[120ms] hover:bg-paper hover:text-hull"
              >
                <X className="size-4" />
              </button>
            </Dialog.Close>
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
      <div className="mt-5 flex items-center gap-2 border-t border-line pt-4">
        <Button
          variant={destructive ? 'danger' : 'primary'}
          onClick={onConfirm}
          disabled={isPending}
        >
          {isPending ? 'Working…' : confirmLabel}
        </Button>
        <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
