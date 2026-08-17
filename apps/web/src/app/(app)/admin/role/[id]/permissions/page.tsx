'use client';

import type { RolePermissionsDto } from '@ff/shared';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ChildScreenHeader } from '@/components/ui/form-layout';
import { PermissionMatrix } from '@/components/ui/permission-matrix';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/** Admin → Role → permission matrix (CLAUDE.md §7 superadmin screen 1). */
export default function RolePermissionsPage() {
  const params = useParams<{ id: string }>();
  const roleId = params.id;
  const { authorizedRequest, can } = useSession();

  const [roleName, setRoleName] = useState('…');
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [isReady, setReady] = useState(false);
  const [isSaving, setSaving] = useState(false);

  const editable = can('ADMIN.ROLE.EDIT');

  const load = useCallback(async () => {
    try {
      const data = await authorizedRequest<RolePermissionsDto>(
        `/api/tenant/admin/roles/${roleId}/permissions`,
      );
      setRoleName(data.roleName);
      setKeys(new Set(data.keys));
      setSavedKeys(new Set(data.keys));
      setReady(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this role.');
    }
  }, [authorizedRequest, roleId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isDirty =
    keys.size !== savedKeys.size || [...keys].some((key) => !savedKeys.has(key));

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await authorizedRequest(`/api/tenant/admin/roles/${roleId}/permissions`, {
        method: 'PUT',
        body: { keys: [...keys] },
      });
      setSavedKeys(new Set(keys));
      toast.success('Saved');
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : 'Could not save these permissions.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ChildScreenHeader
          parentLabel="Role"
          parentName={roleName}
          title="Permissions"
          backHref={'/admin/role' as Route}
        />
        {editable && (
          <div className="flex items-center gap-2">
            {isDirty && (
              <span className="text-cell text-signal">
                Unsaved changes — everyone holding this role will be signed out on save.
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

      <p className="text-cell text-steel">
        <span className="font-mono text-hull" data-numeric="">
          {keys.size}
        </span>{' '}
        permission(s) granted. A role grants; a per-user DENY can still take one away.
      </p>

      {!isReady && error === null ? (
        <p className="text-body text-steel">Loading…</p>
      ) : isReady ? (
        <PermissionMatrix
          mode="role"
          roleKeys={keys}
          disabled={!editable}
          onToggleKey={(key, next) =>
            setKeys((prev) => {
              const updated = new Set(prev);
              if (next) updated.add(key);
              else updated.delete(key);
              return updated;
            })
          }
        />
      ) : null}
    </div>
  );
}
