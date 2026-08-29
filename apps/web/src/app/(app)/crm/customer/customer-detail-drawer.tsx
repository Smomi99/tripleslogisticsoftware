'use client';

import {
  BUSINESS_AREA_LABEL,
  CUSTOMER_TYPE_LABEL,
  type CustomerDto,
} from '@ff/shared';
import Link from 'next/link';

import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';

/**
 * One customer, read without leaving the list.
 *
 * The same reasoning as the agent drawer: a list carries six columns and a
 * customer is mostly the things that do not fit in them — the four monthly
 * volumes, the opening balance, who owns the account, and whatever somebody
 * wrote in the notes. Opening the edit form to read any of it is how a record
 * gets changed by accident.
 *
 * Everything shown is already on the row, so this costs no request and cannot
 * be staler than the table behind it.
 */
export function CustomerDetailDrawer({
  customer,
  onClose,
}: {
  customer: CustomerDto | null;
  onClose: () => void;
}) {
  if (customer === null) return null;

  const facts: [string, string | null][] = [
    ['Code', customer.code],
    ['Type', CUSTOMER_TYPE_LABEL[customer.customerType]],
    ['Business area', BUSINESS_AREA_LABEL[customer.businessArea]],
    ['Commodity', customer.industrySectorName],
    ['Country', customer.country],
    ['Assigned salesman', customer.salesmanName],
    ['Contacts', `${customer.picCount}`],
  ];

  /*
   * §6's four volume figures, laid out as the client writes them: export and
   * import, sea and air. Shown together because the point of them is the
   * comparison — a shipper who moves 40 TEU out and nothing in is a different
   * account from one that moves 20 each way.
   */
  const volumes: [string, string | null][] = [
    ['Export sea', customer.exSeaVolumeTeuMonth === null ? null : `${customer.exSeaVolumeTeuMonth} TEU/month`],
    ['Export air', customer.exAirVolumeKgMonth === null ? null : `${customer.exAirVolumeKgMonth} kg/month`],
    ['Import sea', customer.imSeaVolumeTeuMonth === null ? null : `${customer.imSeaVolumeTeuMonth} TEU/month`],
    ['Import air', customer.imAirVolumeKgMonth === null ? null : `${customer.imAirVolumeKgMonth} kg/month`],
  ];
  const hasVolumes = volumes.some(([, value]) => value !== null);

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      title={customer.name}
      description={`${CUSTOMER_TYPE_LABEL[customer.customerType]} in ${customer.country}.`}
      size="wide"
    >
      <div className="flex flex-col gap-5">
        <div>
          <Status tone={customer.isActive ? 'active' : 'inactive'}>
            {customer.isActive ? 'Active' : 'Inactive'}
          </Status>
        </div>

        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="label-manifest">{label}</dt>
              <dd
                className={
                  label === 'Code' || label === 'Contacts'
                    ? 'font-mono text-body tabular-nums text-hull'
                    : 'text-body text-hull'
                }
              >
                {value === null || value === '' ? '—' : value}
              </dd>
            </div>
          ))}
        </dl>

        {customer.address !== null && customer.address !== '' && (
          <div className="border-t border-line pt-4">
            <dt className="label-manifest">Address</dt>
            <dd className="whitespace-pre-line text-body text-hull">{customer.address}</dd>
          </div>
        )}

        {hasVolumes && (
          <div className="border-t border-line pt-4">
            <span className="label-manifest">Monthly volume</span>
            <dl className="mt-1 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
              {volumes.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-cell text-steel">{label}</dt>
                  <dd className="font-mono text-body tabular-nums text-hull">{value ?? '—'}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {customer.openingBalance !== null && customer.openingBalance !== '' && (
          <div className="border-t border-line pt-4">
            <dt className="label-manifest">Opening balance</dt>
            <dd className="font-mono text-body tabular-nums text-hull">
              {`${customer.openingCurrencyCode ?? ''} ${customer.openingBalance}`.trim()}
            </dd>
          </div>
        )}

        {customer.notes !== null && customer.notes !== '' && (
          <div className="border-t border-line pt-4">
            <dt className="label-manifest">Notes</dt>
            <dd className="whitespace-pre-line text-body text-hull">{customer.notes}</dd>
          </div>
        )}

        <div className="border-t border-line pt-4">
          <Link
            href={{ pathname: `/crm/customer/${customer.id}/pic` }}
            className="text-body text-harbour hover:underline"
          >
            Contacts ({customer.picCount})
          </Link>
        </div>
      </div>
    </Modal>
  );
}
