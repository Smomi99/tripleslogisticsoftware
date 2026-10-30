import { SALES_LEAD_STEPS, type SalesLeadStatus } from '@ff/shared';

import { cn } from '@/lib/utils';

/**
 * §5's recommended workflow as a strip of six steps, with the lead's place on
 * it — capture, qualify, request rate, quote, follow up, convert.
 *
 * A lost lead stopped somewhere along the way; which step is not recorded, so
 * the strip says Lost rather than pretend to know.
 */
export function LeadProgress({ status }: { status: SalesLeadStatus }) {
  const lost = status === 'LOST';
  const at = SALES_LEAD_STEPS.findIndex((step) => step.status === status);

  return (
    <ol aria-label="Lead workflow" className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line md:grid-cols-6">
      {SALES_LEAD_STEPS.map((step, index) => {
        const done = !lost && index < at;
        const current = !lost && index === at;
        return (
          <li
            key={step.status}
            aria-current={current ? 'step' : undefined}
            className={cn('flex flex-col gap-0.5 bg-surface px-3 py-2', current && 'bg-module-soft')}
          >
            <span
              className={cn(
                'font-mono text-cell tabular-nums',
                current ? 'text-harbour' : done ? 'text-verified' : 'text-steel',
              )}
            >
              {String(index + 1).padStart(2, '0')}
              {done && <span className="sr-only"> (done)</span>}
            </span>
            <span className={cn('text-cell font-semibold', current || done ? 'text-hull' : 'text-steel')}>
              {step.label}
            </span>
            <span className="hidden text-cell text-steel lg:block">{step.hint}</span>
          </li>
        );
      })}
      {lost && (
        <li className="col-span-2 bg-alert/5 px-3 py-2 text-cell text-alert md:col-span-6">
          This lead was lost. Its reason is recorded below.
        </li>
      )}
    </ol>
  );
}
