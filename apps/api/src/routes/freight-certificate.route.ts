import { Router } from 'express';

import {
  type ApiSuccess,
  type FreightCertificateDto,
  freightCertificateSaveSchema,
  type FreightCertificateViewDto,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { baseCurrency } from '../lib/currency-rate';
import { isoOf } from '../lib/debit-invoice';
import {
  CERTIFICATE_SELECT,
  certificateDto,
  columnsOf,
  dollarFigure,
  fieldsOf,
  figureDto,
  loadCertificateInvoice,
  lockedReason,
  prefillFields,
} from '../lib/freight-certificate';
import { renderFreightCertificatePdf } from '../lib/freight-certificate-pdf';
import { HttpError } from '../lib/http-error';
import { nextFreightCertificateNo, seriesYearOf } from '../lib/inquiry-no';
import { letterheadOf } from '../lib/letterhead';
import { parseId } from '../lib/request';
import { tenantDayOf } from '../lib/tenant-day';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Accounts → Debit Invoice → Freight Certificate (the client's sample of
 * 2026-10-18; packages/shared/src/freight-certificate.ts).
 *
 * One certificate per debit invoice, so it is addressed through the invoice:
 *
 *   GET   /debit-invoices/:id/freight-certificate        the screen
 *   POST  /debit-invoices/:id/freight-certificate        make it
 *   PATCH /debit-invoices/:id/freight-certificate        change it
 *   GET   /debit-invoices/:id/freight-certificate/pdf    print it
 *
 * Every write re-reads the invoice inside its transaction: the figure is the
 * invoice's as it stands now, never what the browser last saw.
 */
export const freightCertificateRouter: Router = Router();
freightCertificateRouter.use(authenticate);

const FEATURE = 'ACCOUNTS.FREIGHT_CERTIFICATE';
const PATH = '/debit-invoices/:id/freight-certificate';

async function baseCodeOf(db: TenantDb, tenantId: bigint): Promise<string> {
  const base = await baseCurrency(db, tenantId);
  return base === null ? '' : isoOf(base);
}

freightCertificateRouter.get(PATH, requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'debit invoice');

  const data = await withTenant(auth.tenantId, async (db): Promise<FreightCertificateViewDto> => {
    const [invoice, baseCode, dayOf] = await Promise.all([
      loadCertificateInvoice(db, id),
      baseCodeOf(db, auth.tenantId),
      tenantDayOf(db, auth.tenantId),
    ]);
    const locked = lockedReason(invoice);
    const existing = invoice.freightCertificates[0] ?? null;
    if (invoice.shipment === null) throw new HttpError(409, 'NOT_CERTIFIABLE', locked ?? 'There is no shipment to certify.');

    const fields = existing === null ? await prefillFields(db, invoice, dayOf(new Date())) : fieldsOf(existing);
    let figure;
    if (existing === null) {
      const next = await dollarFigure(db, auth.tenantId, invoice, fields.certificateDate);
      figure = figureDto(next.amount, next.rate, baseCode);
    } else {
      figure = figureDto(existing.amount, existing.conversionRate, baseCode);
    }

    return {
      debitInvoiceId: invoice.id.toString(),
      debitInvoiceCode: invoice.code,
      bookingCode: invoice.shipment.code,
      customerName: invoice.customer.name,
      isAir: invoice.shipment.shipmentType === 'AIR',
      certificate: existing === null ? null : certificateDto(existing, baseCode),
      fields,
      figure,
      lockedReason: locked,
      printable: existing !== null && invoice.status !== 'CANCELLED',
    };
  });

  const payload: ApiSuccess<FreightCertificateViewDto> = { success: true, data };
  res.json(payload);
});

freightCertificateRouter.post(PATH, requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'debit invoice');
  const input = freightCertificateSaveSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const invoice = await loadCertificateInvoice(db, id);
    const locked = lockedReason(invoice);
    if (locked !== null) throw new HttpError(409, 'NOT_CERTIFIABLE', locked);
    const existing = invoice.freightCertificates[0];
    if (existing !== undefined) {
      throw new HttpError(
        409,
        'CERTIFICATE_EXISTS',
        `${invoice.code} already has freight certificate ${existing.code}. Open it to make changes.`,
      );
    }

    const figure = await dollarFigure(db, auth.tenantId, invoice, input.certificateDate);
    const baseCode = await baseCodeOf(db, auth.tenantId);
    const year = seriesYearOf(new Date(`${input.certificateDate}T00:00:00.000Z`));

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextFreightCertificateNo(db, auth.tenantId, year);
      try {
        const made = await db.freightCertificate.create({
          data: {
            ...columnsOf(input),
            tenantId: auth.tenantId,
            code,
            seriesYear: year,
            debitInvoiceId: invoice.id,
            currencyId: figure.currencyId,
            amount: figure.amount,
            conversionRate: figure.rate,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: CERTIFICATE_SELECT,
        });
        return certificateDto(made, baseCode);
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        if (isUniqueViolation(error)) {
          throw new HttpError(
            409,
            'CERTIFICATE_EXISTS',
            `${invoice.code} has just been given a freight certificate by somebody else. Open it from the invoice.`,
          );
        }
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a freight certificate number.');
  });

  const payload: ApiSuccess<FreightCertificateDto> = { success: true, data };
  res.status(201).json(payload);
});

freightCertificateRouter.patch(PATH, requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'debit invoice');
  const input = freightCertificateSaveSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const invoice = await loadCertificateInvoice(db, id);
    const existing = invoice.freightCertificates[0];
    if (existing === undefined) throw HttpError.notFound(`${invoice.code} has no freight certificate yet.`);
    const locked = lockedReason(invoice);
    if (locked !== null) throw new HttpError(409, 'NOT_CERTIFIABLE', `${locked} Its certificate cannot be changed.`);

    // The figure follows the invoice: re-priced since, the certificate says so.
    const figure = await dollarFigure(db, auth.tenantId, invoice, input.certificateDate);
    const saved = await db.freightCertificate.update({
      where: { id: existing.id },
      data: {
        ...columnsOf(input),
        currencyId: figure.currencyId,
        amount: figure.amount,
        conversionRate: figure.rate,
        updatedBy: auth.userId,
      },
      select: CERTIFICATE_SELECT,
    });
    return certificateDto(saved, await baseCodeOf(db, auth.tenantId));
  });

  const payload: ApiSuccess<FreightCertificateDto> = { success: true, data };
  res.json(payload);
});

/**
 * Printed from what is stored, every time — the certificate is a document
 * that can still be corrected, so there is no frozen copy to go stale.
 */
freightCertificateRouter.get(`${PATH}/pdf`, requirePermission(`${FEATURE}.EXPORT_PDF`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'debit invoice');

  const result = await withTenant(auth.tenantId, async (db) => {
    const invoice = await loadCertificateInvoice(db, id);
    const existing = invoice.freightCertificates[0];
    if (existing === undefined) throw HttpError.notFound(`${invoice.code} has no freight certificate yet.`);
    if (invoice.status === 'CANCELLED') {
      throw new HttpError(409, 'NOT_CERTIFIABLE', `${invoice.code} was cancelled, so its freight certificate cannot be printed.`);
    }

    const [letterhead, baseCode] = await Promise.all([letterheadOf(db, auth.tenantId), baseCodeOf(db, auth.tenantId)]);
    const fields = fieldsOf(existing);
    const figure = figureDto(existing.amount, existing.conversionRate, baseCode);
    const pdf = await renderFreightCertificatePdf({
      companyName: letterhead.companyName,
      refNo: existing.code,
      isAir: invoice.shipment?.shipmentType === 'AIR',
      ...fields,
      amount: figure.amount,
      amountInWords: figure.amountInWords,
      // A workspace whose base is the dollar has nothing to convert.
      conversionRate: baseCode === 'USD' ? null : figure.conversionRate,
      baseCurrencyCode: baseCode,
    });
    return { pdf, filename: `${existing.code}.pdf` };
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.send(result.pdf);
});
