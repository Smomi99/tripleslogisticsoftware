'use client';

import { Check, ChevronDown, Search } from 'lucide-react';
import {
  type ComponentPropsWithRef,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

import { controlClasses } from './control';

/**
 * The dropdown — every one in the product, with a search box (client,
 * 2026-11-01: "on every dropdown like POL / POD … there should be search
 * option. Please do it for all the dropdown").
 *
 * It keeps the native <select>'s contract so none of the 200-odd call sites
 * change: <option> and <optgroup> children, `value` + `onChange`, or
 * react-hook-form's register() spread straight in. A real <select> stays in
 * the DOM, out of sight, and holds the value; this component draws the
 * control people see and writes their choice back into it, firing the same
 * change event the native control fires. Options are read from that select's
 * DOM, so whatever produced them — a map, a fragment, a group — they appear.
 *
 * The list opens in the browser's top layer (the Popover API), so a modal's
 * scroll box, a table's sideways scroll or a transformed dialog never clips
 * it, while it stays inside its parent in the DOM — a dialog's focus trap and
 * outside-click rules still count it as part of the dialog.
 *
 * Keyboard: ↓ / ↑ or typing opens it, typing filters, ↓ / ↑ move, Enter picks,
 * Escape closes without changing anything. On a touch screen the search box
 * is not focused on open, so the keyboard does not cover a short list; tap it
 * to filter a long one.
 */

interface Choice {
  value: string;
  text: string;
  disabled: boolean;
  group: string | null;
  /** Its position among the native select's options — its selectedIndex. */
  index: number;
}

/** A long list draws this many matches at a time; typing narrows it. */
const RENDER_LIMIT = 300;
/** The list never gets narrower than this, so short triggers still read. */
const MIN_PANEL_WIDTH = 224;
const PANEL_MAX_HEIGHT = 320;
const GAP = 4;
const EDGE = 8;
/** Fired on the native select when something outside this component sets its value. */
const SYNC_EVENT = 'ff-select-sync';

function readChoices(select: HTMLSelectElement): Choice[] {
  return Array.from(select.options, (option, index) => {
    const parent = option.parentElement;
    const group = parent instanceof HTMLOptGroupElement ? parent : null;
    return {
      value: option.value,
      text: option.label,
      disabled: option.disabled || group?.disabled === true,
      group: group?.label ?? null,
      index,
    };
  });
}

const signatureOf = (choices: Choice[]): string =>
  choices.map((c) => `${c.value}\u0001${c.text}\u0001${c.disabled ? 1 : 0}\u0001${c.group ?? ''}`).join('\u0002');

/** Every word typed must appear somewhere in the option or its group: "chit bd". */
function matches(choice: Choice, words: string[]): boolean {
  const haystack = `${choice.text} ${choice.group ?? ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Where a long list's window starts: at the top, or around the option it must show. */
function windowFor(length: number, mustShow: number): number {
  if (length <= RENDER_LIMIT || mustShow < RENDER_LIMIT) return 0;
  return Math.min(mustShow - RENDER_LIMIT / 2, length - RENDER_LIMIT);
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref !== null && ref !== undefined) ref.current = value;
}

/** Elements already taught to report outside writes; patched once each. */
const patched = new WeakSet<HTMLSelectElement>();

/**
 * react-hook-form writes `select.value` directly on reset() and setValue(),
 * which fires no event. Report those writes, so the control shows the value
 * the form now holds; and send focus() — the form focusing a field with an
 * error — to the control people can see.
 */
function patchSelect(select: HTMLSelectElement, focusTarget: () => HTMLElement | null): void {
  if (patched.has(select)) return;
  patched.add(select);
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const get = descriptor?.get;
  const set = descriptor?.set;
  if (get !== undefined && set !== undefined) {
    Object.defineProperty(select, 'value', {
      configurable: true,
      get(): string {
        return get.call(select) as string;
      },
      set(next: string) {
        set.call(select, next);
        select.dispatchEvent(new Event(SYNC_EVENT));
      },
    });
  }
  select.focus = (options?: FocusOptions) => focusTarget()?.focus(options);
}

function supportsPopover(element: HTMLElement): boolean {
  return typeof element.showPopover === 'function';
}

interface Placement {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export type SelectProps = ComponentPropsWithRef<'select'> & {
  /** Placeholder for the search box. */
  searchPlaceholder?: string;
};

export function Select({
  id,
  className,
  children,
  ref,
  disabled,
  autoFocus,
  title,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  'aria-required': ariaRequired,
  searchPlaceholder = 'Type to search',
  ...nativeProps
}: SelectProps) {
  const autoId = useId();
  const triggerId = id ?? autoId;
  const listId = `${triggerId}-list`;
  const optionId = (index: number) => `${triggerId}-option-${index}`;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const signatureRef = useRef('');

  const [choices, setChoices] = useState<Choice[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isOpen, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** Position of the highlighted option within `shown`. */
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const syncValue = useCallback(() => {
    const select = selectRef.current;
    if (select !== null) setSelectedIndex(select.selectedIndex);
  }, []);

  const syncChoices = useCallback(() => {
    const select = selectRef.current;
    if (select === null) return;
    const next = readChoices(select);
    const signature = signatureOf(next);
    if (signature !== signatureRef.current) {
      signatureRef.current = signature;
      setChoices(next);
    }
    setSelectedIndex(select.selectedIndex);
  }, []);

  const setSelect = useCallback(
    (select: HTMLSelectElement | null) => {
      selectRef.current = select;
      // Patched before the form library's ref sees it: register() writes the
      // default value from inside its ref callback.
      if (select !== null) patchSelect(select, () => triggerRef.current);
      assignRef(ref, select);
    },
    [ref],
  );

  // A controlled value, or new options, arrive as a render: read the select
  // after each one. Unchanged state is a no-op, so this cannot loop.
  useLayoutEffect(() => {
    syncValue();
  });

  useLayoutEffect(() => {
    const select = selectRef.current;
    if (select === null) return;
    syncChoices();
    // Options that change without this component rendering — a child
    // component's own state — still reach the list.
    const observer = new MutationObserver(syncChoices);
    observer.observe(select, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['value', 'label', 'disabled'],
    });
    // A form's native reset restores defaults without any event on the field.
    const form = select.form;
    const onReset = () => window.setTimeout(syncValue, 0);
    form?.addEventListener('reset', onReset);
    select.addEventListener('change', syncValue);
    select.addEventListener(SYNC_EVENT, syncValue);
    return () => {
      observer.disconnect();
      form?.removeEventListener('reset', onReset);
      select.removeEventListener('change', syncValue);
      select.removeEventListener(SYNC_EVENT, syncValue);
    };
  }, [syncChoices, syncValue]);

  const visible = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
    if (words.length === 0) return choices;
    // The blank "Choose…" row is not a match for anything typed.
    return choices.filter((c) => c.value !== '' && matches(c, words));
  }, [choices, query]);
  // A long list draws a window of it. With nothing typed the window holds the
  // current option, so opening a field never hides what is in it.
  const windowStart = windowFor(visible.length, query === '' ? selectedIndex : -1);
  const shown = visible.length > RENDER_LIMIT ? visible.slice(windowStart, windowStart + RENDER_LIMIT) : visible;

  const selected = selectedIndex >= 0 ? choices[selectedIndex] : undefined;
  const isPlaceholder = selected === undefined || selected.value === '';

  /** Below the trigger if it fits, above if there is more room there. */
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(Math.max(rect.width, MIN_PANEL_WIDTH), viewportWidth - 2 * EDGE);
    const left = Math.min(Math.max(rect.left, EDGE), viewportWidth - width - EDGE);
    const below = viewportHeight - rect.bottom - GAP - EDGE;
    const above = rect.top - GAP - EDGE;
    if (below >= Math.min(PANEL_MAX_HEIGHT, 200) || below >= above) {
      setPlacement({ left, width, top: rect.bottom + GAP, maxHeight: Math.max(120, Math.min(PANEL_MAX_HEIGHT, below)) });
    } else {
      setPlacement({ left, width, bottom: viewportHeight - rect.top + GAP, maxHeight: Math.min(PANEL_MAX_HEIGHT, above) });
    }
  }, []);

  const firstEnabled = useCallback(
    (list: Choice[], from = 0) => {
      for (let i = from; i < list.length; i += 1) if (list[i]?.disabled === false) return i;
      return -1;
    },
    [],
  );

  function open(seed = ''): void {
    if (disabled === true) return;
    place();
    setQuery(seed);
    // With nothing typed the list is every option, so the current one is
    // highlighted where it stands; with a letter typed, the first match is.
    const start = windowFor(choices.length, selectedIndex);
    setActive(seed !== '' ? 0 : selectedIndex >= 0 ? selectedIndex - start : firstEnabled(choices));
    setOpen(true);
  }

  const close = useCallback((refocus: boolean) => {
    if (refocus) triggerRef.current?.focus();
    setOpen(false);
    setQuery('');
  }, []);

  function choose(choice: Choice | undefined): void {
    const select = selectRef.current;
    if (select === null || choice === undefined || choice.disabled) return;
    if (select.selectedIndex !== choice.index) {
      select.selectedIndex = choice.index;
      // The event the native control fires: React's onChange and
      // react-hook-form both listen for exactly this.
      select.dispatchEvent(new Event('change', { bubbles: true }));
      // A controlled parent that refuses the change has React put the old
      // value back once this event is done; show whichever value stands.
      queueMicrotask(syncValue);
    }
    syncValue();
    close(true);
  }

  // Into the top layer, then focus inside it.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    if (panel !== null && supportsPopover(panel)) {
      try {
        panel.showPopover();
      } catch {
        // Already showing, or detached mid-render — the fixed position still holds.
      }
    }
    const finePointer = window.matchMedia('(pointer: fine)').matches;
    (finePointer ? searchRef.current : listRef.current)?.focus({ preventScroll: true });
  }, [isOpen]);

  // Keep the highlighted option in view as the arrows move it.
  useEffect(() => {
    if (!isOpen || active < 0) return;
    const choice = shown[active];
    if (choice === undefined) return;
    document.getElementById(optionId(choice.index))?.scrollIntoView({ block: 'nearest' });
    // optionId is derived from triggerId, which never changes.
  }, [isOpen, active, shown]);

  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(event: PointerEvent): void {
      // The list is inside the wrapper in the DOM, wherever it is drawn.
      if (!(event.target instanceof Node) || !wrapperRef.current?.contains(event.target)) close(false);
    }
    // Escape is caught on the window, before a dialog around this field hears
    // it: it closes the list, not the dialog.
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
    function onScroll(event: Event): void {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      place();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
  }, [isOpen, close, place]);

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (isOpen) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Typing on the closed control starts the search with that letter.
      event.preventDefault();
      open(event.key);
    }
  }

  function move(from: number, step: number): number {
    let i = from;
    for (let n = 0; n < shown.length; n += 1) {
      i = Math.min(Math.max(i + step, 0), shown.length - 1);
      if (shown[i]?.disabled === false) return i;
      if (i === 0 || i === shown.length - 1) break;
    }
    return from;
  }

  function onPanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const inSearch = event.target === searchRef.current;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((a) => (a < 0 ? firstEnabled(shown) : move(a, 1)));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActive((a) => move(a, -1));
        return;
      case 'PageDown':
        event.preventDefault();
        setActive((a) => move(Math.min(a + 9, shown.length - 1), 1));
        return;
      case 'PageUp':
        event.preventDefault();
        setActive((a) => move(Math.max(a - 9, 0), -1));
        return;
      case 'Enter':
        // Never the form's submit: Enter here picks an option.
        event.preventDefault();
        choose(shown[active]);
        return;
      case 'Tab':
        // Back to the control; forward, focus moves on and the list closes behind it.
        if (event.shiftKey) {
          event.preventDefault();
          close(true);
        }
        return;
      default:
        if (!inSearch && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          // Typing while the list has focus (a tablet's keyboard) searches.
          event.preventDefault();
          setQuery((q) => q + event.key);
          setActive(0);
          searchRef.current?.focus({ preventScroll: true });
        }
    }
  }

  function onWrapperBlur(event: ReactFocusEvent<HTMLDivElement>): void {
    // The blur this handler sends to the native select bubbles back here.
    const from: EventTarget = event.target;
    if (from === selectRef.current) return;
    if (event.relatedTarget instanceof Node && wrapperRef.current?.contains(event.relatedTarget)) return;
    if (isOpen) close(false);
    // The field is left: tell the form library, as the native select did.
    selectRef.current?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  const panelStyle: CSSProperties | undefined =
    placement === null
      ? undefined
      : {
          left: placement.left,
          width: placement.width,
          maxHeight: placement.maxHeight,
          ...(placement.top !== undefined ? { top: placement.top } : { bottom: placement.bottom }),
        };
  const activeChoice = active >= 0 ? shown[active] : undefined;
  const activeId = activeChoice === undefined ? undefined : optionId(activeChoice.index);

  return (
    // className places the control in its layout (a grid span, a width), so
    // it sits on the box, not on the button inside it.
    <div ref={wrapperRef} className={cn('relative w-full min-w-0', className)} onBlur={onWrapperBlur}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        aria-required={ariaRequired ?? nativeProps.required}
        disabled={disabled}
        autoFocus={autoFocus}
        title={title}
        onClick={() => (isOpen ? close(false) : open())}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          controlClasses,
          'flex items-center gap-2 pr-2 text-left sm:pr-2',
          isOpen && 'border-harbour ring-3 ring-harbour/20',
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate', isPlaceholder && 'text-steel')}>
          {selected?.text ?? ' '}
        </span>
        <ChevronDown
          className={cn('size-4 shrink-0 text-steel transition-transform duration-[120ms] ease-manifest', isOpen && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div
          ref={panelRef}
          popover="manual"
          style={panelStyle}
          onKeyDown={onPanelKeyDown}
          className="fixed inset-auto z-[60] m-0 flex flex-col overflow-hidden rounded-card border border-line bg-surface p-0 text-hull shadow-raised"
        >
          <div className="relative shrink-0 border-b border-line p-1.5">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-steel" aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              aria-label={ariaLabel === undefined ? searchPlaceholder : `Search ${ariaLabel}`}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="done"
              value={query}
              placeholder={searchPlaceholder}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              className="h-10 w-full rounded-manifest border border-line bg-surface pl-8 pr-2.5 text-base text-hull placeholder:text-steel focus:border-harbour focus:outline-none focus:ring-3 focus:ring-harbour/20 sm:h-8 sm:text-body"
            />
          </div>
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label={ariaLabel ?? 'Options'}
            aria-activedescendant={activeId}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 outline-none"
          >
            {shown.length === 0 ? (
              <li role="presentation" className="px-3 py-2.5 text-cell text-steel">
                {query.trim() === '' ? 'Nothing to choose from yet.' : `Nothing matches “${query.trim()}”. Check the spelling, or try part of the name or code.`}
              </li>
            ) : (
              shown.map((choice, position) => {
                const isSelected = choice.index === selectedIndex;
                const startsGroup = choice.group !== null && shown[position - 1]?.group !== choice.group;
                return (
                  <li key={choice.index} role="presentation">
                    {startsGroup && <div className="label-manifest px-3 pb-1 pt-2">{choice.group}</div>}
                    <div
                      id={optionId(choice.index)}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={choice.disabled || undefined}
                      // Keeps focus in the search box, so the list stays open to the click.
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => {
                        if (!choice.disabled && position !== active) setActive(position);
                      }}
                      onClick={() => choose(choice)}
                      className={cn(
                        'flex items-start gap-2 px-3 py-2.5 text-body sm:py-1.5',
                        choice.disabled ? 'cursor-not-allowed text-steel/60' : 'cursor-pointer',
                        position === active && !choice.disabled && 'bg-row-hover',
                        choice.value === '' && 'text-steel',
                        isSelected && 'font-medium text-hull',
                        choice.group !== null && 'pl-5',
                      )}
                    >
                      <Check
                        className={cn('mt-0.5 size-4 shrink-0', isSelected ? 'text-harbour' : 'invisible')}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 break-words">{choice.text === '' ? ' ' : choice.text}</span>
                    </div>
                  </li>
                );
              })
            )}
            {visible.length > shown.length && (
              <li role="presentation" className="border-t border-line px-3 py-2 text-cell text-steel">
                Showing {shown.length} of {visible.length.toLocaleString('en-US')}. Type to find the rest.
              </li>
            )}
          </ul>
        </div>
      )}

      {/* The value's real home: the form, the form library and React read it here. */}
      <select
        ref={setSelect}
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        className="pointer-events-none absolute inset-0 size-full opacity-0"
        {...nativeProps}
      >
        {children}
      </select>
    </div>
  );
}
