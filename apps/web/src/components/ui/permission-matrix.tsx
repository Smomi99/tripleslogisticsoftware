'use client';

import {
  type Action,
  ACTIONS,
  featuresByModule,
  type OverrideState,
  permissionKey,
} from '@ff/shared';
import { Check, Minus, X } from 'lucide-react';
import { Fragment, useMemo } from 'react';

import { MODULE_LABEL } from '@/components/shell/nav-config';
import { cn } from '@/lib/utils';

import { Button } from './button';

/**
 * The §7 permission matrix: features grouped by module down the rows, actions
 * across the columns, with select-all per row and per column.
 *
 * Two modes, because §7 asks for two screens with the same layout:
 *
 *   role — a plain checkbox per cell.
 *   user — three states per cell: inherited from the role (grey check),
 *          explicitly allowed (green), explicitly denied (red). DENY beats
 *          everything except superadmin, so a denied cell reads as refused even
 *          where the role grants it.
 *
 * A cell is only rendered where the feature actually declares that action —
 * §7's action list is the vocabulary, not a promise that every screen supports
 * every verb.
 */

export interface PermissionMatrixProps {
  mode: 'role' | 'user';
  /** Keys granted directly (role mode) or by the role (user mode). */
  roleKeys: ReadonlySet<string>;
  /** User mode only: explicit per-user overrides. */
  overrides?: ReadonlyMap<string, 'ALLOW' | 'DENY'>;
  disabled?: boolean;
  /** role mode: toggle a key on or off. */
  onToggleKey?: (key: string, next: boolean) => void;
  /** user mode: move a cell to a specific state. */
  onSetOverride?: (key: string, next: OverrideState) => void;
}

const ACTION_LABEL: Record<Action, string> = {
  VIEW: 'View',
  CREATE: 'Create',
  EDIT: 'Edit',
  TOGGLE_STATUS: 'Status',
  DELETE: 'Delete',
  EXPORT: 'Export',
  APPROVE: 'Approve',
  // Column-level rather than screen-level — see PURCHASE.RATE in the registry.
  VIEW_BUY_PRICE: 'Buy price',
  MANAGE_PROFIT: 'Margin',
  // The inquiry's row scope and workflow actions (§4 rule 10, §5.5, §9 Q10).
  VIEW_ALL: 'All rows',
  FOLLOWUP: 'Follow up',
  ATTACH_PRICE: 'Attach price',
  CONVERT_QUOTE: 'Quote',
  SET_OUTCOME: 'Won / lost',
};

export function PermissionMatrix({
  mode,
  roleKeys,
  overrides,
  disabled = false,
  onToggleKey,
  onSetOverride,
}: PermissionMatrixProps) {
  const groups = useMemo(() => featuresByModule(), []);

  // DELETE is granted to no feature (§4 rule 3), so its column would always be
  // empty. Dropping it keeps the grid honest rather than showing a dead column.
  const actions = useMemo(
    () =>
      ACTIONS.filter((action) =>
        groups.some((group) => group.features.some((f) => f.actions.includes(action))),
      ),
    [groups],
  );

  function cellState(key: string): OverrideState {
    if (mode === 'role') return roleKeys.has(key) ? 'ALLOW' : 'INHERIT';
    const override = overrides?.get(key);
    if (override !== undefined) return override;
    return 'INHERIT';
  }

  function isEffective(key: string): boolean {
    if (mode === 'role') return roleKeys.has(key);
    const override = overrides?.get(key);
    if (override === 'DENY') return false;
    if (override === 'ALLOW') return true;
    return roleKeys.has(key);
  }

  /** role mode: click toggles. user mode: cycles inherit → allow → deny. */
  function onCellClick(key: string): void {
    if (disabled) return;
    if (mode === 'role') {
      onToggleKey?.(key, !roleKeys.has(key));
      return;
    }
    const current = cellState(key);
    const next: OverrideState =
      current === 'INHERIT' ? 'ALLOW' : current === 'ALLOW' ? 'DENY' : 'INHERIT';
    onSetOverride?.(key, next);
  }

  function setMany(keys: string[], grant: boolean): void {
    if (disabled) return;
    for (const key of keys) {
      if (mode === 'role') onToggleKey?.(key, grant);
      else onSetOverride?.(key, grant ? 'ALLOW' : 'DENY');
    }
  }

  return (
    <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
      <table className="w-full border-collapse text-cell">
        <thead className="sticky top-0 z-20">
          <tr className="bg-paper">
            <th className="label-manifest sticky left-0 z-30 min-w-56 border-b border-r border-line bg-paper px-3 py-2 text-left">
              Feature
            </th>
            {actions.map((action) => {
              const columnKeys = groups.flatMap((group) =>
                group.features
                  .filter((f) => f.actions.includes(action))
                  .map((f) => permissionKey(f.feature, action)),
              );
              return (
                <th key={action} className="border-b border-line px-2 py-2 text-center">
                  <span className="label-manifest block">{ACTION_LABEL[action]}</span>
                  {!disabled && (
                    <span className="mt-0.5 flex justify-center gap-1">
                      <button
                        type="button"
                        onClick={() => setMany(columnKeys, true)}
                        className="text-cell text-harbour hover:underline"
                        aria-label={`Grant ${ACTION_LABEL[action]} everywhere`}
                      >
                        all
                      </button>
                      <span className="text-steel">/</span>
                      <button
                        type="button"
                        onClick={() => setMany(columnKeys, false)}
                        className="text-cell text-steel hover:text-alert hover:underline"
                        aria-label={`Clear ${ACTION_LABEL[action]} everywhere`}
                      >
                        none
                      </button>
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {groups.map((group) => (
            <Fragment key={group.module}>
              <tr className="bg-paper/60">
                <td
                  colSpan={actions.length + 1}
                  className="sticky left-0 border-y border-line px-3 py-1.5"
                >
                  <span className="label-manifest text-hull">{MODULE_LABEL[group.module]}</span>
                </td>
              </tr>

              {group.features.map((feature) => {
                const rowKeys = feature.actions.map((action) =>
                  permissionKey(feature.feature, action),
                );
                return (
                  <tr key={feature.feature} className="group border-b border-line last:border-b-0">
                    <td className="sticky left-0 z-10 border-r border-line bg-surface px-3 py-1 transition-colors group-hover:bg-row-hover">
                      <span className="text-cell text-hull">{feature.label}</span>
                      {!disabled && (
                        <span className="ml-2 inline-flex gap-1">
                          <button
                            type="button"
                            onClick={() => setMany(rowKeys, true)}
                            className="text-cell text-harbour hover:underline"
                            aria-label={`Grant everything on ${feature.label}`}
                          >
                            all
                          </button>
                          <span className="text-steel">/</span>
                          <button
                            type="button"
                            onClick={() => setMany(rowKeys, false)}
                            className="text-cell text-steel hover:text-alert hover:underline"
                            aria-label={`Clear everything on ${feature.label}`}
                          >
                            none
                          </button>
                        </span>
                      )}
                    </td>

                    {actions.map((action) => {
                      if (!feature.actions.includes(action)) {
                        return (
                          <td
                            key={action}
                            className="bg-surface px-2 py-1 text-center text-steel transition-colors group-hover:bg-row-hover"
                          >
                            <span aria-hidden="true">·</span>
                            <span className="sr-only">Not applicable</span>
                          </td>
                        );
                      }

                      const key = permissionKey(feature.feature, action);
                      const state = cellState(key);
                      const effective = isEffective(key);

                      return (
                        <td
                          key={action}
                          className="bg-surface px-2 py-1 text-center transition-colors group-hover:bg-row-hover"
                        >
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => onCellClick(key)}
                            aria-label={`${feature.label} — ${ACTION_LABEL[action]}: ${state}`}
                            aria-pressed={effective}
                            className={cn(
                              'inline-flex size-6 items-center justify-center rounded-manifest border',
                              'transition-colors duration-[120ms] ease-manifest',
                              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-harbour',
                              disabled && 'cursor-not-allowed opacity-60',
                              state === 'DENY'
                                ? 'border-alert/40 bg-alert/10 text-alert'
                                : state === 'ALLOW'
                                  ? 'border-verified/40 bg-verified/10 text-verified'
                                  : effective
                                    ? 'border-line bg-paper text-steel'
                                    : 'border-line bg-surface text-transparent hover:border-harbour/40',
                            )}
                          >
                            {state === 'DENY' ? (
                              <X className="size-3.5" />
                            ) : state === 'ALLOW' ? (
                              <Check className="size-3.5" />
                            ) : effective ? (
                              <Check className="size-3.5" />
                            ) : (
                              <Minus className="size-3.5" />
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The three-state key, shown above the user matrix. */
export function MatrixLegend({ onReset }: { onReset?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-cell text-steel">
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-flex size-5 items-center justify-center rounded-manifest border border-line bg-paper text-steel">
          <Check className="size-3" />
        </span>
        Inherited from role
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-flex size-5 items-center justify-center rounded-manifest border border-verified/40 bg-verified/10 text-verified">
          <Check className="size-3" />
        </span>
        Allowed explicitly
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-flex size-5 items-center justify-center rounded-manifest border border-alert/40 bg-alert/10 text-alert">
          <X className="size-3" />
        </span>
        Denied explicitly — beats the role
      </span>
      {onReset !== undefined && (
        <Button variant="text" size="inline" onClick={onReset} className="ml-auto">
          Reset to role default
        </Button>
      )}
    </div>
  );
}
