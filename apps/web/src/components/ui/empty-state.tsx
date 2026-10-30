import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';

/*
 * Empty states invite the action — "No carriers yet. Add your first carrier to
 * start building price lists." Never a shrug and a blank box.
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
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center sm:py-14">
      <span
        aria-hidden="true"
        className="mb-1 flex size-12 items-center justify-center rounded-full bg-module-soft text-harbour"
      >
        <Inbox className="size-6" />
      </span>
      <p className="text-section text-hull">{title}</p>
      <p className="max-w-md text-body text-steel">{description}</p>
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}
