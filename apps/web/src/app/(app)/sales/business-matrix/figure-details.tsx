'use client';

import {
  BUSINESS_MATRIX_DETAIL_LIMIT,
  BUSINESS_MATRIX_FIGURE_LABEL,
  type BusinessMatrixDetailDto,
  type BusinessMatrixFigure,
  INQUIRY_STATUS_LABEL,
  INQUIRY_STATUS_TONE,
  QUOTATION_STATUS_LABEL,
  QUOTATION_STATUS_TONE,
  RATE_MODE_LABEL,
  type RateMode,
  type TradeLaneDirection,
  type TradeLanePortDto,
} from '@ff/shared';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';

import { amount, money } from '@/components/accounts/format';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { isStatusHeader, useEndPins } from '@/components/ui/table-scroll';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

/**
 * What a Business Matrix cell counted (client, 2026-11-01): "all the count on
 * business matrix … pop up and show the specific information".
 *
 * The server lists the records with the statement that counted them, so the
 * list and the number agree. Where the source screen keeps a record from this
 * user (a colleague's inquiry, a price list they do not hold) the popup says
 * how many, rather than showing a list that quietly falls short of the cell.
 */

export interface FigureTarget {
  figure: BusinessMatrixFigure;
  movementType: TradeLaneDirection;
  pol: TradeLanePortDto;
  pod: TradeLanePortDto;
  /** The matrix's period, when one is set. Live rates ignore it. */
  from: string;
  to: string;
}

const NOUN: Record<BusinessMatrixFigure, [string, string]> = {
  liveRates: ['live rate', 'live rates'],
  inquiries: ['inquiry', 'inquiries'],
  quotations: ['quotation', 'quotations'],
  teus: ['container', 'containers'],
  revenue: ['invoice', 'invoices'],
};

const PRICE_LIST_PATH: Record<RateMode, string> = {
  SEA_FCL: '/purchase/price-list-fcl',
  SEA_LCL: '/purchase/price-list-lcl',
  AIR: '/purchase/price-list-air',
};

/** "3 inquiries", with the number in mono like every other figure (§12). */
function Count({ n, figure }: { n: number; figure: BusinessMatrixFigure }) {
  return (
    <>
      <span className="font-mono tabular-nums">{n.toLocaleString('en-US')}</span> {NOUN[figure][n === 1 ? 0 : 1]}
    </>
  );
}

export function FigureDetails({ target, onClose }: { target: FigureTarget; onClose: () => void }) {
  const { authorizedRequest } = useSession();
  const [data, setData] = useState<BusinessMatrixDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { figure, movementType, pol, pod, from, to } = target;

  useEffect(() => {
    let current = true;
    const params = new URLSearchParams({ figure, movementType, polId: pol.id, podId: pod.id });
    if (from !== '') params.set('from', from);
    if (to !== '') params.set('to', to);
    authorizedRequest<BusinessMatrixDetailDto>(`/api/tenant/sales/business-matrix/details?${params.toString()}`)
      .then((found) => {
        if (current) setData(found);
      })
      .catch((caught: unknown) => {
        if (current) setError(caught instanceof ApiError ? caught.message : 'Could not load these records. Try again.');
      });
    return () => {
      current = false;
    };
  }, [authorizedRequest, figure, movementType, pol.id, pod.id, from, to]);

  const period =
    figure === 'liveRates'
      ? `Rates live today${data?.figure === 'liveRates' ? `, ${data.asOf}` : ''}, whatever period the matrix shows.`
      : from === '' && to === ''
        ? 'All dates.'
        : `${from === '' ? 'From the first record' : `From ${from}`} ${to === '' ? 'to today' : `to ${to}`}.`;

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="wide"
      title={`${BUSINESS_MATRIX_FIGURE_LABEL[figure]}: ${pol.name} → ${pod.name}`}
      description={period}
    >
      {error !== null ? (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      ) : data === null ? (
        <p className="py-8 text-center text-body text-steel" aria-busy="true">
          Loading the {NOUN[figure][1]}…
        </p>
      ) : (
        <DetailBody data={data} />
      )}
    </Modal>
  );
}

function DetailBody({ data }: { data: BusinessMatrixDetailDto }) {
  const shownAll = data.rows.length >= data.total;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-hull">
        <Count n={data.total} figure={data.figure} />
        {data.figure === 'teus' && (
          <>
            , <span className="font-mono tabular-nums">{amount(data.sum)}</span> TEUs
          </>
        )}
        {data.figure === 'revenue' && (
          <>
            , <span className="font-mono tabular-nums">{money(data.currency, data.sum)}</span> in all
          </>
        )}
        {!shownAll && (
          <span className="text-steel">
            {' '}
            — showing the first <span className="font-mono tabular-nums">{BUSINESS_MATRIX_DETAIL_LIMIT}</span>
          </span>
        )}
        .
      </p>

      {data.hidden > 0 && (
        <p className="rounded-manifest border border-signal/30 bg-signal/5 px-3 py-2 text-body text-signal-ink">
          <Count n={data.hidden} figure={data.figure} /> more {data.hidden === 1 ? 'is' : 'are'}{' '}
          {data.figure === 'liveRates'
            ? 'on a price list you do not have access to.'
            : `counted here but ${data.hidden === 1 ? 'belongs' : 'belong'} to colleagues. You can open the ones that are yours.`}
        </p>
      )}

      {data.rows.length > 0 && <DetailTable data={data} />}
    </div>
  );
}

const head = 'label-manifest whitespace-nowrap border-b border-line px-3 py-2';
const cell = 'px-3 py-2 align-top';
// Dates, codes and amounts stay whole: the table scrolls rather than breaking 2026-10-30 in two.
const mono = 'whitespace-nowrap font-mono tabular-nums';
const codeClass = 'whitespace-nowrap font-mono font-medium tabular-nums text-harbour';
const linkClass = cn(
  codeClass,
  'rounded-sm underline decoration-harbour/30 underline-offset-2 transition-colors duration-[120ms] hover:decoration-harbour',
  'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-harbour/30',
);

type Pins = ReturnType<typeof useEndPins>;

/** A status column pins to the right, as on every table (owner, 2026-11-01). */
function Table({ columns, pin, children }: { columns: [string, 'left' | 'right'][]; pin: Pins; children: ReactNode }) {
  return (
    <div {...pin.box} className="group/scroller overflow-x-auto rounded-card border border-line">
      <table className="w-full min-w-[40rem] border-collapse text-cell">
        <thead>
          <tr ref={pin.rowRef} className="bg-module-soft">
            {columns.map(([label, align]) => {
              const className = cn(head, align === 'right' ? 'text-right' : 'text-left');
              return isStatusHeader(label) ? (
                <th key={label} scope="col" {...pin.head(0, className)}>
                  {label}
                </th>
              ) : (
                <th key={label} scope="col" className={className}>
                  {label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const rowClass = 'group border-b border-line last:border-b-0 hover:bg-row-hover';

function DetailTable({ data }: { data: BusinessMatrixDetailDto }) {
  const pin = useEndPins([data]);
  switch (data.figure) {
    case 'liveRates': {
      const modes = [...new Set(data.rows.map((r) => r.mode))];
      return (
        <>
          <Table
            pin={pin}
            columns={[
              ['Rate', 'left'],
              ['Mode', 'left'],
              ['Carrier', 'left'],
              ['Goods type', 'left'],
              ['Valid', 'left'],
              ['Transit', 'right'],
              ['Sell price', 'left'],
            ]}
          >
            {data.rows.map((r) => (
              <tr key={r.id} className={rowClass}>
                <td className={cn(cell, codeClass)}>{r.code}</td>
                <td className={cell}>{RATE_MODE_LABEL[r.mode]}</td>
                <td className={cell}>
                  {r.carrierName}
                  {r.route !== null && r.route !== '' && <div className="text-steel">{r.route}</div>}
                </td>
                <td className={cell}>{r.goodsTypeName}</td>
                <td className={cn(cell, mono, 'whitespace-nowrap')}>
                  {r.validFrom} – {r.validTo}
                </td>
                <td className={cn(cell, mono, 'text-right')}>{r.transitDays === null ? '—' : `${r.transitDays} d`}</td>
                <td className={cell}>
                  {r.lines.length === 0 ? (
                    <span className="text-steel">No prices yet</span>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {r.lines.map((line, i) => (
                        <li key={i} className="flex justify-between gap-3 whitespace-nowrap">
                          <span>{line.label}</span>
                          <span className={mono}>{line.sellPrice === null ? '—' : money(r.currencyCode, line.sellPrice)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </Table>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-cell text-steel">
            Buy prices and margins are on the Price List.
            {modes.map((mode) => (
              <Link key={mode} href={PRICE_LIST_PATH[mode]} className="font-medium text-harbour hover:underline">
                Open Price List — {RATE_MODE_LABEL[mode]}
              </Link>
            ))}
          </p>
        </>
      );
    }
    case 'inquiries':
      return (
        <Table
          pin={pin}
          columns={[
            ['Inquiry', 'left'],
            ['Date', 'left'],
            ['Customer', 'left'],
            ['Salesman', 'left'],
            ['Status', 'left'],
          ]}
        >
          {data.rows.map((r) => (
            <tr key={r.id} className={rowClass}>
              <td className={cn(cell, codeClass)}>{r.code}</td>
              <td className={cn(cell, mono)}>{r.inquiryDate}</td>
              <td className={cell}>{r.customerName}</td>
              <td className={cell}>{r.salesmanName ?? <span className="text-steel">Not assigned</span>}</td>
              <td {...pin.cell(0, cell)}>
                <Status tone={r.isLapsed ? 'overdue' : INQUIRY_STATUS_TONE[r.status]}>
                  {r.isLapsed ? 'Lapsed' : INQUIRY_STATUS_LABEL[r.status]}
                </Status>
              </td>
            </tr>
          ))}
        </Table>
      );
    case 'quotations':
      return (
        <Table
          pin={pin}
          columns={[
            ['Quotation', 'left'],
            ['Rev', 'right'],
            ['Date', 'left'],
            ['Customer', 'left'],
            ['Carrier', 'left'],
            ['Status', 'left'],
          ]}
        >
          {data.rows.map((r) => (
            <tr key={r.id} className={rowClass}>
              <td className={cell}>
                <Link href={`/cs/quotation/${r.id}`} className={linkClass}>
                  {r.code}
                </Link>
              </td>
              <td className={cn(cell, mono, 'text-right')}>{r.revisionNo}</td>
              <td className={cn(cell, mono)}>{r.quotationDate}</td>
              <td className={cell}>{r.customerName}</td>
              <td className={cell}>{r.carrierName}</td>
              <td {...pin.cell(0, cell)}>
                <Status tone={QUOTATION_STATUS_TONE[r.status]}>{QUOTATION_STATUS_LABEL[r.status]}</Status>
              </td>
            </tr>
          ))}
        </Table>
      );
    case 'teus':
      return (
        <Table
          pin={pin}
          columns={[
            ['Load plan', 'left'],
            ['Container', 'left'],
            ['Size', 'left'],
            ['TEUs', 'right'],
            ['Loaded', 'left'],
            ['Carrier', 'left'],
            ['Bookings', 'left'],
          ]}
        >
          {data.rows.map((r) => (
            <tr key={r.id} className={rowClass}>
              <td className={cell}>
                <Link href={`/operation/container-load-plan/${r.id}`} className={linkClass}>
                  {r.code}
                </Link>
              </td>
              <td className={cn(cell, mono)}>{r.containerNo ?? <span className="font-sans text-steel">Not recorded</span>}</td>
              <td className={cn(cell, mono)}>{r.containerSize}</td>
              <td className={cn(cell, mono, 'text-right')}>{amount(r.teus)}</td>
              <td className={cn(cell, mono)}>{r.loadedOn}</td>
              <td className={cell}>{r.carrierName}</td>
              <td className={cn(cell, mono)}>{r.bookings.join(', ')}</td>
            </tr>
          ))}
        </Table>
      );
    case 'revenue':
      return (
        <Table
          pin={pin}
          columns={[
            ['Invoice', 'left'],
            ['Date', 'left'],
            ['Customer', 'left'],
            ['Booking', 'left'],
            ['Amount', 'right'],
            [`In ${data.currency === '' ? 'base' : data.currency}`, 'right'],
          ]}
        >
          {data.rows.map((r) => (
            <tr key={r.id} className={rowClass}>
              <td className={cell}>
                <Link href={`/accounts/debit-invoice/${r.id}`} className={linkClass}>
                  {r.code}
                </Link>
              </td>
              <td className={cn(cell, mono)}>{r.invoiceDate}</td>
              <td className={cell}>{r.customerName}</td>
              <td className={cn(cell, mono)}>{r.bookingCode}</td>
              <td className={cn(cell, mono, 'whitespace-nowrap text-right')}>{money(r.currencyCode, r.totalAmount)}</td>
              <td className={cn(cell, mono, 'text-right')}>{amount(r.totalAmountBase)}</td>
            </tr>
          ))}
        </Table>
      );
  }
}
