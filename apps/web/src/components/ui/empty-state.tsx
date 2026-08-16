import type { ReactNode } from 'react';

/*
 * §12: empty states invite the action — "No carriers yet. Add your first
 * carrier to start building price lists." Never a shrug and a blank box.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-section text-hull">{title}</p>
      <p className="max-w-md text-body text-steel">{description}</p>
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}
