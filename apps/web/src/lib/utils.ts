import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/*
 * The §12 type scale (globals.css --text-*) is named, not numbered. Untold,
 * tailwind-merge reads `text-body` as a colour and drops the real colour
 * beside it: a primary button lost `text-white` to its size and printed navy
 * on teal, and every text button lost its harbour or alert.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['page-title', 'section', 'body', 'cell', 'label'] }],
    },
  },
});

/** Merges class names, letting a caller's utility override a component default. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
