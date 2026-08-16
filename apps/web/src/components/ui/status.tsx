import { cn } from '@/lib/utils';

/*
 * §12: status is NOT a coloured pill. A 6px dot plus a label — quieter, and it
 * survives a dense grid where fifty pills would not.
 */
export type StatusTone = 'active' | 'inactive' | 'pending' | 'overdue';

const TONE: Record<StatusTone, { dot: string; label: string }> = {
  active: { dot: 'bg-verified', label: 'text-hull' },
  inactive: { dot: 'bg-steel', label: 'text-steel' },
  pending: { dot: 'bg-signal', label: 'text-hull' },
  overdue: { dot: 'bg-alert', label: 'text-hull' },
};

export function Status({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  const styles = TONE[tone];
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span
        className={cn('size-1.5 shrink-0 rounded-full', styles.dot)}
        aria-hidden="true"
      />
      <span className={cn('text-cell', styles.label)}>{children}</span>
    </span>
  );
}

/** The Active/Inactive toggle state every §8 list screen shows. */
export function ActiveStatus({ isActive }: { isActive: boolean }) {
  return (
    <Status tone={isActive ? 'active' : 'inactive'}>
      {isActive ? 'Active' : 'Inactive'}
    </Status>
  );
}
