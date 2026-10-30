'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown } from 'lucide-react';
import {
  Children,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useRef,
} from 'react';

import { cn } from '@/lib/utils';

/*
 * A row's actions, drawn the same way in every table.
 *
 *   one or two actions   each a small pill button, side by side
 *   three or more        the first as a pill, the rest under "More ▾"
 *
 * A row with seven actions used to be a 600px strip of links in a sticky
 * column, laid over the table's own columns. Keeping the column to two pills
 * gives the data back its width.
 *
 * Screens pass their actions exactly as before — a fragment of Buttons and
 * Links, some behind permission checks. This flattens the fragment, drops what
 * a permission check left out, and restyles each one, so no screen changes.
 * Colour still comes from the action itself: --harbour, or --alert for a
 * destructive one. The "More" button says "More", not an icon — the users are
 * not power users on day one.
 */

/** At or under this many, every action shows; above it, the first shows and the rest fold away. */
const MAX_INLINE = 2;

function flatten(node: ReactNode): ReactElement[] {
  return Children.toArray(node).flatMap((child): ReactElement[] => {
    if (!isValidElement(child)) {
      // Bare text between actions ("·") is decoration, not an action.
      return [];
    }
    if (child.type === Fragment) {
      return flatten((child.props as { children?: ReactNode }).children);
    }
    return [child];
  });
}

/*
 * The pill look is applied to whatever each action is (a Button, a Link, a
 * plain anchor) through child selectors, so screens keep passing what they
 * already pass. Only buttons and links become pills: a plain span in the row
 * ("Awaiting approval") is a note, and must not look like something to press.
 * Arbitrary variants sort after the actions' own utilities, so the pill's
 * size and padding win over an inline button's p-0.
 */
const PILL = cn(
  '[&>:is(a,button)]:inline-flex [&>:is(a,button)]:shrink-0 [&>:is(a,button)]:items-center [&>:is(a,button)]:gap-1',
  '[&>:is(a,button)]:whitespace-nowrap [&>:is(a,button)]:rounded-full [&>:is(a,button)]:border [&>:is(a,button)]:border-line',
  '[&>:is(a,button)]:bg-surface [&>:is(a,button)]:font-medium [&>:is(a,button)]:no-underline [&>:is(a,button):hover]:no-underline',
  '[&>:is(a,button)]:transition-colors [&>:is(a,button)]:duration-[120ms]',
  '[&>:is(a,button):hover]:border-harbour/40 [&>:is(a,button):hover]:bg-row-hover',
  '[&>span]:whitespace-nowrap [&>span]:text-cell [&>span]:text-steel',
);

export function RowActions({
  children,
  layout = 'table',
}: {
  children: ReactNode;
  /** "card" is the phone layout: bigger tap targets, left-aligned, wrapping. */
  layout?: 'table' | 'card';
}) {
  const items = flatten(children);
  if (items.length === 0) return null;

  const folds = items.length > MAX_INLINE;
  const inline = folds ? items.slice(0, 1) : items;
  const folded = folds ? items.slice(1) : [];

  return (
    <div
      className={cn(
        'flex items-center gap-1.5',
        PILL,
        layout === 'table'
          ? 'justify-end [&>:is(a,button)]:h-7 [&>:is(a,button)]:px-3 [&>:is(a,button)]:text-cell'
          : 'flex-wrap gap-2 [&>:is(a,button)]:h-9 [&>:is(a,button)]:px-3.5 [&>:is(a,button)]:text-body',
      )}
    >
      {inline}
      {folded.length > 0 && <MoreMenu items={folded} />}
    </div>
  );
}

function MoreMenu({ items }: { items: ReactElement[] }) {
  // An action that opens a dialog must keep the dialog's focus: when the menu
  // closes because something was chosen, it does not hand focus back to "More".
  const chose = useRef(false);

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger className="text-hull data-[state=open]:border-harbour/40 data-[state=open]:bg-row-hover">
        More
        <ChevronDown className="size-3.5 text-steel" aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            if (chose.current) event.preventDefault();
            chose.current = false;
          }}
          className={cn(
            'z-50 flex min-w-48 flex-col rounded-card border border-line bg-surface p-1.5 shadow-raised animate-fade-in',
            '[&>*]:flex [&>*]:h-auto [&>*]:w-full [&>*]:items-center [&>*]:justify-start [&>*]:gap-2',
            '[&>*]:whitespace-nowrap [&>*]:rounded-manifest [&>*]:px-3 [&>*]:py-2 [&>*]:text-left [&>*]:text-body [&>*]:font-medium',
            '[&>*]:no-underline [&>*:hover]:no-underline [&>*]:outline-none',
            '[&>*[data-highlighted]]:bg-row-hover [&>*[data-disabled]]:opacity-50',
          )}
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.key}
              asChild
              disabled={(item.props as { disabled?: unknown }).disabled === true}
              onSelect={() => {
                chose.current = true;
              }}
            >
              {item}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
