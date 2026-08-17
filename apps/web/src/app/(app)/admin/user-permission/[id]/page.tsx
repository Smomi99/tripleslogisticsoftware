'use client';

import type { OverrideState, UserPermissionsDto } from '@ff/shared';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ChildScreenHeader } from '@/components/ui/form-layout';
import { MatrixLegend, PermissionMatrix } from '@/components/ui/permission-matrix';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Admin → User permissions (CLAUDE.md §7 superadmin screen 3).
 *
 * Three states per cell, and a reset to role default. A superadmin holds
 * everything regardless (§7 rule 1), so the matrix is shown read-only for one —
 * editing it would imply the overrides matter, and they do not.
 */
export default function UserPermissionsPage() {
  const params = useParams<{ id: string }>();
  const userId = params.id;
  const { authorizedRequest, can } = useSession();

  const [data, setData] = useState<UserPermissionsDto | null>(null);
  const [overrides, setOverrides] = useState<Map<string, 'ALLOW' | 'DENY'>>(new Map());
  const [saved, setSaved] = useState<Map<string, 'ALLOW' | 'DENY'>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await authorizedRequest<UserPermissionsDto>(
        `/api/tenant/admin/users/${userId}/permissions`,
      );
      const map = new Map(loaded.overrides.map((o) => [o.key, o.effect]));
      setData(loaded);
      setOverrides(new Map(map));
      setSaved(new Map(map));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this user.');
    }
  }, [authorizedRequest, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const editable = can('ADMIN.USER_PERMISSION.EDIT') && data?.isSuperadmin !== true;

  const isDirty =
    overrides.size !== saved.size ||
    [...overrides].some(([key, effect]) => saved.get(key) !== effect);

  function setOverride(key: string, next: OverrideState): void {
    setOverrides((prev) => {
      const updated = new Map(prev);
      if (next === 'INHERIT') updated.delete(key);
      else updated.set(key, next);
      return updated;
    });
  }

  async function save(nextOverrides = overrides): Promise<void> {
    setSaving(true);
    try {
      await authorizedRequest(`/api/tenant/admin/users/${userId}/permissions`, {
        method: 'PUT',
        body: {
          overrides: [...nextOverrides].map(([key, effect]) => ({ key, effect })),
        },
      });
      setSaved(new Map(nextOverrides));
      toast.success('Saved');
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not save these overrides.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ChildScreenHeader
          parentLabel="User"
          parentName={data?.username ?? '…'}
          title="Permissions"
          backHref={'/crm/user' as Route}
        />
        {editable && (
          <div className="flex items-center gap-2">
            {isDirty && (
              <span className="text-cell text-signal">
                Unsaved changes — this user will be signed out on save.
              </span>
            )}
            <Button onClick={() => void save()} disabled={!isDirty || isSaving}>
              {isSaving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      {data !== null && data.isSuperadmin && (
        <p className="rounded-manifest border border-line bg-paper px-3 py-2 text-body text-hull">
          This user is a superadmin, so they hold every permission regardless of what is set here
          (§7 rule 1). Remove the superadmin flag on the User screen to make these overrides matter.
        </p>
      )}

      {data !== null && (
        <p className="text-cell text-steel">
          Role{' '}
          <span className="text-hull">{data.roleName ?? 'none'}</span> grants{' '}
          <span className="font-mono text-hull" data-numeric="">
            {data.roleKeys.length}
          </span>
          ; after overrides this user effectively holds{' '}
          <span className="font-mono text-hull" data-numeric="">
            {data.isSuperadmin ? 'all' : data.effectiveKeys.length}
          </span>
          .
        </p>
      )}

      <MatrixLegend
        onReset={
          editable && overrides.size > 0
            ? () => {
                setOverrides(new Map());
                void save(new Map());
              }
            : undefined
        }
      />

      {data === null && error === null ? (
        <p className="text-body text-steel">Loading…</p>
      ) : data !== null ? (
        <PermissionMatrix
          mode="user"
          roleKeys={new Set(data.roleKeys)}
          overrides={overrides}
          disabled={!editable}
          onSetOverride={setOverride}
        />
      ) : null}
    </div>
  );
}
