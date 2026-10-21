'use client';

import {
  type CreditInvoiceDto,
  DEBIT_INVOICE_DISPLAY_STATUS_LABEL,
  type DebitInvoiceDto,
  type DebitInvoiceLineDto,
  SUPPLIER_PARTY_LABEL,
  SUPPLIER_PAYMENT_STATUS_LABEL,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { amount, DISPLAY_STATUS_TONE, money, PAYMENT_TONE } from './format';

/**
 * The popups the invoice numbers open on the Debit Invoice and Credit Invoice
 * lists: the whole document, read-only, without leaving the list. Changing it
 * is still the full page's job — the Edit action, or the link at the foot.
 */

/** One record, fetched when its path is set. Null while closed or loading. */
export function useRecord<T>(path: string | null): { data: T | null; error: string | null } {
  const { authorizedRequest } = useSession();
  const [state, setState] = useState<{ path: string; data: T | null; error: string | null } | null>(null);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    authorizedRequest<T>(path).then(
      (data) => {
        if (!cancelled) setState({ path, data, error: null });
      },
      (caught: unknown) => {
        if (!cancelled) {
          setState({ path, data: null, error: caught instanceof ApiError ? caught.message : 'Could not load it.' });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, path]);

  // What was fetched for another number is not this one: show loading, not it.
  return state !== null && state.path === path ? state : { data: null, error: null };
}

/** Shown in place of the record until it arrives, or when it cannot. */
export function Pending({ error }: { error: string | null }) {
  if (error === null) return <p className="text-body text-steel">Loading…</p>;
  return (
    <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
      {error}
    </p>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="label-manifest">{label}</dt>
      <dd className="text-body text-hull">{children ?? '—'}</dd>
    </div>
  );
}

const FACTS = 'grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4';
const TOTALS = `${FACTS} rounded-manifest border border-line bg-paper/60 p-4`;
const TH = 'label-manifest px-3 py-2';
const TD = 'px-3 py-2 text-cell text-hull';
const TD_NUM = `${TD} text-right font-mono tabular-nums`;

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono tabular-nums">{children}</span>;
}

/** A figure in its own currency, and in base beneath it when they differ. */
function TwoCurrencies({ code, value, baseCode, baseValue }: { code: string; value: string; baseCode: string; baseValue: string }) {
  return (
    <span className="font-mono tabular-nums">
      {money(code, value)}
      {code !== baseCode && <span className="block text-cell text-steel">{money(baseCode, baseValue)}</span>}
    </span>
  );
}

/** The charge grid, as the invoice page shows it read-only. */
function LineTable({
  lines,
  priceLabel,
  currencyCode,
  baseCode,
}: {
  lines: DebitInvoiceLineDto[];
  priceLabel: string;
  currencyCode: string;
  baseCode: string;
}) {
  if (lines.length === 0) return <p className="text-cell text-steel">No charges on it.</p>;
  return (
    <div className="overflow-x-auto rounded-manifest border border-line">
      <table className="w-full min-w-160 border-collapse">
        <thead>
          <tr className="border-b border-line bg-paper">
            <th className={`${TH} text-left`}>Cost head</th>
            <th className={`${TH} text-left`}>Container size</th>
            <th className={`${TH} text-left`}>Unit</th>
            <th className={`${TH} text-right`}>Qty</th>
            <th className={`${TH} text-right`}>{priceLabel}</th>
            <th className={`${TH} text-right`}>Total Amount ({currencyCode})</th>
            <th className={`${TH} text-right`}>Total Amount ({baseCode || 'base'})</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-b border-line last:border-b-0">
              <td className={TD}>{l.costHeadName}</td>
              <td className={TD}>{l.containerSizeName ?? '—'}</td>
              <td className={TD}>{l.unitName ?? '—'}</td>
              <td className={TD_NUM}>{l.quantity}</td>
              <td className={TD_NUM}>{amount(l.unitPrice)}</td>
              <td className={TD_NUM}>{amount(l.amount)}</td>
              <td className={TD_NUM}>{amount(l.amountBase)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-section text-hull">{title}</h3>
      {children}
    </section>
  );
}

function Footer({ children, onClose }: { children?: ReactNode; onClose: () => void }) {
  return (
    <div className="mt-5 flex items-center justify-end gap-4 border-t border-line pt-4">
      {children}
      <Button variant="secondary" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

// ===========================================================================
// Debit invoice
// ===========================================================================

export function DebitInvoiceDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useSession();
  const { data: invoice, error } = useRecord<DebitInvoiceDto>(
    id === null ? null : `/api/tenant/accounts/debit-invoices/${id}`,
  );

  return (
    <Modal
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={invoice === null ? 'Debit Invoice' : `Debit Invoice ${invoice.code}`}
      {...(invoice === null ? {} : { description: invoice.customerName })}
      size="wide"
    >
      {invoice === null ? <Pending error={error} /> : <DebitInvoiceBody invoice={invoice} />}

      <Footer onClose={onClose}>
        {invoice !== null && <PrintButton invoiceId={invoice.id} />}
        {invoice !== null && <FreightCertificateLink invoice={invoice} />}
        {invoice !== null && (
          <Link href={`/accounts/debit-invoice/${invoice.id}` as Route} className="text-body text-harbour hover:underline">
            {invoice.status !== 'CANCELLED' && can('ACCOUNTS.DEBIT_INVOICE.EDIT') ? 'Edit invoice' : 'Open invoice'}
          </Link>
        )}
      </Footer>
    </Modal>
  );
}

/**
 * The debit note as printed, in a new tab — the invoice page's Print, without
 * opening the invoice first (client, 2026-10-21).
 */
function PrintButton({ invoiceId }: { invoiceId: string }) {
  const { can, authorizedObjectUrl } = useSession();
  const [opening, setOpening] = useState(false);
  if (!can('ACCOUNTS.DEBIT_INVOICE.EXPORT_PDF')) return null;

  async function print(): Promise<void> {
    setOpening(true);
    try {
      const url = await authorizedObjectUrl(`/api/tenant/accounts/debit-invoices/${invoiceId}/pdf`);
      window.open(url, '_blank', 'noopener');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not open the invoice.');
    } finally {
      setOpening(false);
    }
  }

  return (
    <Button variant="text" size="inline" className="text-body" disabled={opening} onClick={() => void print()}>
      {opening ? 'Opening…' : 'Print'}
    </Button>
  );
}

/**
 * The Freight Certificate (the client's sample of 2026-10-18): made from an
 * issued invoice with a booking, then opened from here to change or print.
 */
function FreightCertificateLink({ invoice }: { invoice: DebitInvoiceDto }) {
  const { can } = useSession();
  if (!can('ACCOUNTS.FREIGHT_CERTIFICATE.VIEW')) return null;
  const href = `/accounts/debit-invoice/${invoice.id}/freight-certificate` as Route;
  const className = 'text-body text-harbour hover:underline';

  if (invoice.freightCertificate !== null) {
    return (
      <Link href={href} className={className}>
        Freight Certificate <span className="font-mono tabular-nums">{invoice.freightCertificate.code}</span>
      </Link>
    );
  }
  if (invoice.status !== 'ISSUED' || invoice.booking === null || !can('ACCOUNTS.FREIGHT_CERTIFICATE.CREATE')) return null;
  return (
    <Link href={href} className={className}>
      Create Freight Certificate
    </Link>
  );
}

function DebitInvoiceBody({ invoice }: { invoice: DebitInvoiceDto }) {
  const { can } = useSession();
  const booking = invoice.booking;
  const isAir = booking?.shipmentType === 'AIR';
  const baseCode = invoice.baseCurrencyCode;
  const grossProfit = invoice.grossProfitBase;

  return (
    <div className="flex flex-col gap-5">
      {invoice.status === 'CANCELLED' && (
        <p className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          Cancelled {invoice.cancelledAt?.slice(0, 10)} — {invoice.cancelReason}
        </p>
      )}

      <dl className={FACTS}>
        <Fact label="Status">
          <Status tone={DISPLAY_STATUS_TONE[invoice.displayStatus]}>
            {DEBIT_INVOICE_DISPLAY_STATUS_LABEL[invoice.displayStatus]}
          </Status>
        </Fact>
        <Fact label="Invoice Date">
          <Mono>{invoice.invoiceDate}</Mono>
        </Fact>
        <Fact label="Customer">{invoice.customerName}</Fact>
        <Fact label="Currency">
          <Mono>
            {invoice.currencyCode}
            {invoice.currencyCode !== baseCode && ` · ${invoice.conversionRate}`}
          </Mono>
        </Fact>
        {booking === null ? (
          <Fact label="Shipment Type">Other</Fact>
        ) : (
          <>
            <Fact label="Booking No">
              <Mono>{booking.bookingCode}</Mono>
            </Fact>
            <Fact label="Quotation No">{booking.quotationCode === null ? null : <Mono>{booking.quotationCode}</Mono>}</Fact>
            <Fact label="Inquiry No">{booking.inquiryCode === null ? null : <Mono>{booking.inquiryCode}</Mono>}</Fact>
            <Fact label="Shipment Type">{isAir ? 'Air' : 'Sea'}</Fact>
            <Fact label={isAir ? 'AOL' : 'POL'}>{booking.polName}</Fact>
            <Fact label={isAir ? 'AOD' : 'POD'}>{booking.podName}</Fact>
            <Fact label={isAir ? 'Airlines' : 'Carrier'}>{booking.carrierName}</Fact>
            <Fact label="Commodity">{booking.commodity}</Fact>
            <Fact label="Required Container">{booking.requiredContainer}</Fact>
          </>
        )}
      </dl>

      <Section title="Selling">
        <LineTable lines={invoice.lines} priceLabel="Selling price" currencyCode={invoice.currencyCode} baseCode={baseCode} />
      </Section>

      {/* §3.9: null, not empty, when the viewer may not see buy prices. */}
      {invoice.costs !== null && invoice.costs.length > 0 && (
        <Section title="Buying">
          <div className="overflow-x-auto rounded-manifest border border-line">
            <table className="w-full min-w-160 border-collapse">
              <thead>
                <tr className="border-b border-line bg-paper">
                  <th className={`${TH} text-left`}>Vendor / Agent / Carrier</th>
                  <th className={`${TH} text-left`}>Vendor/Agent/Carrier Inv No</th>
                  <th className={`${TH} text-right`}>Total Cost</th>
                  <th className={`${TH} text-right`}>Total Cost ({baseCode || 'base'})</th>
                  <th className={`${TH} text-left`}>Payment Status</th>
                </tr>
              </thead>
              <tbody>
                {invoice.costs.map((c) => (
                  <tr key={c.id} className="border-b border-line last:border-b-0">
                    <td className={TD}>
                      {c.partyName} <span className="text-steel">· {SUPPLIER_PARTY_LABEL[c.partyType]}</span>
                    </td>
                    <td className={`${TD} font-mono tabular-nums`}>{c.supplierInvoiceNo ?? '—'}</td>
                    <td className={TD_NUM}>{money(c.currencyCode, c.totalAmount)}</td>
                    <td className={TD_NUM}>{amount(c.totalAmountBase)}</td>
                    <td className={TD}>
                      <Status tone={PAYMENT_TONE[c.paymentStatus]}>{SUPPLIER_PAYMENT_STATUS_LABEL[c.paymentStatus]}</Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <dl className={TOTALS}>
        <Fact label="Total Sell price">
          <TwoCurrencies
            code={invoice.currencyCode}
            value={invoice.totalAmount}
            baseCode={baseCode}
            baseValue={invoice.totalAmountBase}
          />
        </Fact>
        {invoice.costTotalBase !== null && (
          <>
            <Fact label="Grand total cost">
              <Mono>{money(baseCode, invoice.costTotalBase)}</Mono>
            </Fact>
            <Fact label="Gross profit">
              <span className={`font-mono tabular-nums ${Number(grossProfit) < 0 ? 'text-alert' : ''}`}>
                {money(baseCode, grossProfit)}
              </span>
            </Fact>
            <Fact label="GP %">
              <Mono>{invoice.grossProfitPercent === null ? '—' : `${invoice.grossProfitPercent}%`}</Mono>
            </Fact>
          </>
        )}
        {invoice.status === 'ISSUED' && (
          <>
            <Fact label="Received">
              <Mono>{money(invoice.currencyCode, invoice.receivedAmount)}</Mono>
            </Fact>
            <Fact label="Outstanding">
              <Mono>{money(invoice.currencyCode, invoice.outstandingAmount)}</Mono>
            </Fact>
          </>
        )}
      </dl>

      {invoice.receipts.length > 0 && (
        <Section title="Received">
          <ul className="flex flex-col gap-1">
            {invoice.receipts.map((r) => (
              <li key={r.id} className="font-mono text-cell tabular-nums text-hull">
                {r.paymentDate} · {money(invoice.currencyCode, r.amount)}
                {r.journalEntryId !== null && (
                  <>
                    {' · '}
                    {can('ACCOUNTS.INCOME.VIEW') ? (
                      <Link href={`/accounts/income/${r.journalEntryId}` as Route} className="text-harbour hover:underline">
                        {r.journalEntryCode}
                      </Link>
                    ) : (
                      r.journalEntryCode
                    )}
                  </>
                )}
                {r.bankChargeBase !== null && ` · Bank charge ${money(baseCode, r.bankChargeBase)}`}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

// ===========================================================================
// Credit invoice
// ===========================================================================

export function CreditInvoiceDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useSession();
  const { data: credit, error } = useRecord<CreditInvoiceDto>(
    id === null ? null : `/api/tenant/accounts/credit-invoices/${id}`,
  );

  return (
    <Modal
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={credit === null ? 'Credit Invoice' : `Credit Invoice ${credit.supplierInvoiceNo ?? ''}`.trim()}
      {...(credit === null ? {} : { description: `${credit.partyName} · ${SUPPLIER_PARTY_LABEL[credit.partyType]}` })}
      size="wide"
    >
      {credit === null ? <Pending error={error} /> : <CreditInvoiceBody credit={credit} />}

      <Footer onClose={onClose}>
        {credit !== null && credit.paymentStatus !== 'PAID' && can('ACCOUNTS.EXPENSE.CREATE') && (
          <Link href={`/accounts/expense/new?creditInvoice=${credit.id}` as Route} className="text-body text-harbour hover:underline">
            Make Payment
          </Link>
        )}
      </Footer>
    </Modal>
  );
}

function CreditInvoiceBody({ credit }: { credit: CreditInvoiceDto }) {
  const { can, authorizedDownload } = useSession();
  const baseCode = credit.baseCurrencyCode;
  const fileName = credit.supplierInvoiceFileName;

  function download(name: string): void {
    void authorizedDownload(
      `/api/tenant/accounts/debit-invoices/${credit.debitInvoiceId}/costs/${credit.id}/file`,
      name,
    ).catch((caught: unknown) =>
      toast.error(caught instanceof ApiError ? caught.message : 'Could not download the file.'),
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <dl className={FACTS}>
        <Fact label="Payment Status">
          <Status tone={PAYMENT_TONE[credit.paymentStatus]}>{SUPPLIER_PAYMENT_STATUS_LABEL[credit.paymentStatus]}</Status>
        </Fact>
        <Fact label="Date">
          <Mono>{credit.date}</Mono>
        </Fact>
        <Fact label="Vendor / Agent / Carrier">
          {credit.partyName} <span className="text-steel">· {SUPPLIER_PARTY_LABEL[credit.partyType]}</span>
        </Fact>
        <Fact label="Vendor/Agent/Carrier Inv No">
          {credit.supplierInvoiceNo === null ? null : <Mono>{credit.supplierInvoiceNo}</Mono>}
        </Fact>
        <Fact label="Debit Invoice No">
          {can('ACCOUNTS.DEBIT_INVOICE.VIEW') ? (
            <Link
              href={`/accounts/debit-invoice/${credit.debitInvoiceId}` as Route}
              className="font-mono tabular-nums text-harbour hover:underline"
            >
              {credit.debitInvoiceCode}
            </Link>
          ) : (
            <Mono>{credit.debitInvoiceCode}</Mono>
          )}
        </Fact>
        <Fact label="Booking No">{credit.bookingCode === null ? null : <Mono>{credit.bookingCode}</Mono>}</Fact>
        <Fact label="Customer">{credit.customerName}</Fact>
        <Fact label="Currency">
          <Mono>
            {credit.currencyCode}
            {credit.currencyCode !== baseCode && ` · ${credit.conversionRate}`}
          </Mono>
        </Fact>
        <Fact label="Invoice file">
          {fileName === null ? (
            'Not uploaded'
          ) : can('ACCOUNTS.DEBIT_INVOICE.VIEW_BUY_PRICE') ? (
            // The route that serves it is the buy-price grant's (the debit invoice page's).
            <Button variant="text" size="inline" onClick={() => download(fileName)}>
              {fileName}
            </Button>
          ) : (
            fileName
          )}
        </Fact>
      </dl>

      <Section title="Charges">
        <LineTable lines={credit.lines} priceLabel="Buying price" currencyCode={credit.currencyCode} baseCode={baseCode} />
      </Section>

      <dl className={TOTALS}>
        <Fact label="Total Cost">
          <TwoCurrencies code={credit.currencyCode} value={credit.totalAmount} baseCode={baseCode} baseValue={credit.totalAmountBase} />
        </Fact>
        <Fact label="Paid">
          <Mono>{money(credit.currencyCode, credit.paidAmount)}</Mono>
        </Fact>
        <Fact label="Outstanding">
          <Mono>{money(credit.currencyCode, credit.outstandingAmount)}</Mono>
        </Fact>
      </dl>

      {credit.payments.length > 0 && (
        <Section title="Paid">
          <ul className="flex flex-col gap-1">
            {credit.payments.map((p) => (
              <li key={p.id} className="font-mono text-cell tabular-nums text-hull">
                {p.paymentDate} · {money(credit.currencyCode, p.amount)}
                {' · '}
                {can('ACCOUNTS.EXPENSE.VIEW') ? (
                  <Link href={`/accounts/expense/${p.journalEntryId}` as Route} className="text-harbour hover:underline">
                    {p.journalEntryCode}
                  </Link>
                ) : (
                  p.journalEntryCode
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
