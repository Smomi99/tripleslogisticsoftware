import { cn } from '@/lib/utils';

/*
 * Status is a soft pill: a dot and a label on a faint tint of the status
 * colour. The -ink shades keep the label above 4.5:1 on its own tint.
 */
export type StatusTone = 'active' | 'inactive' | 'pending' | 'overdue';

const TONE: Record<StatusTone, { pill: string; dot: string }> = {
  active: { pill: 'bg-verified/10 text-verified-ink', dot: 'bg-verified' },
  inactive: { pill: 'bg-steel/10 text-steel', dot: 'bg-steel' },
  pending: { pill: 'bg-signal/10 text-signal-ink', dot: 'bg-signal' },
  overdue: { pill: 'bg-alert/10 text-alert', dot: 'bg-alert' },
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
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-cell font-medium',
        styles.pill,
        className,
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', styles.dot)} aria-hidden="true" />
      {children}
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
