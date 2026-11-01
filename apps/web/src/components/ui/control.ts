import { cn } from '@/lib/utils';

/*
 * The look every single-line control shares — inputs and the dropdown's
 * trigger alike, so a row of fields lines up whatever kind each one is:
 *   - 36px tall (40px on a phone), 8px radius, 1px --line
 *   - 16px text on a phone: iOS zooms the page into anything smaller
 *   - focus turns the border to the module colour with a soft ring around it
 */
export const controlClasses = cn(
  'h-10 w-full rounded-manifest border border-line bg-surface px-3 sm:h-9 sm:px-2.5',
  'text-base text-hull transition-[border-color,box-shadow] duration-[120ms] ease-manifest sm:text-body',
  'hover:border-steel/50',
  'focus:border-harbour focus:outline-none focus:ring-3 focus:ring-harbour/20',
  'disabled:cursor-not-allowed disabled:bg-paper disabled:text-steel',
  'aria-[invalid=true]:border-alert aria-[invalid=true]:focus:ring-alert/20',
);
