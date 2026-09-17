'use client';

/**
 * A row of mutually exclusive tabs — "To plan | Container plans", "FCL | LCL".
 *
 * One component so every switch on a screen is drawn the same way; two
 * hand-rolled copies drifting apart is how two halves of one job come to look
 * like different products.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** Names the group for a screen reader. */
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="inline-flex shrink-0 rounded-manifest border border-line bg-surface p-0.5"
      role="tablist"
      aria-label={label}
    >
      {options.map(([key, text]) => (
        <button
          key={key === '' ? 'all' : key}
          type="button"
          role="tab"
          aria-selected={value === key}
          onClick={() => onChange(key)}
          className={
            value === key
              ? 'whitespace-nowrap rounded-[3px] bg-harbour px-3 py-1.5 text-cell font-semibold text-white'
              : 'whitespace-nowrap rounded-[3px] px-3 py-1.5 text-cell text-steel transition-colors duration-[120ms] hover:text-hull'
          }
        >
          {text}
        </button>
      ))}
    </div>
  );
}
