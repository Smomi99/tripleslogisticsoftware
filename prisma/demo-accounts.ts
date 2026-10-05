/* eslint-disable no-console */
import { Prisma, type PrismaClient } from '../apps/api/src/generated/prisma/client';
import { ensureChart } from '../apps/api/src/lib/ledger';
import type { TenantDb } from '../apps/api/src/lib/tenant-client';

/**
 * Demo data for Accounts — the whole money loop, so the Transaction screens,
 * the Receivable-Payable list, Shipment Profitability and the Income
 * Statement (both bases) have something true to show.
 *
 *   pnpm db:demo:accounts         rebuild only this part (DEMO-ACC- rows)
 *   pnpm db:demo:accounts:clear   take only this part out
 *
 * Twenty-two months, today back, so Current Month, YTD and Previous Year YTD
 * all have figures whichever month the financial year starts in. Each month:
 *
 *   jobs        three FCL exports (USD), two LCL (BDT) and two Air (USD),
 *               each booked, invoiced (Debit Invoice) and costed — carrier,
 *               agent and vendor blocks (Credit Invoice) — for four customers
 *   operations  every booking taken the whole way the screens would take it
 *               before it is invoiced: schedule, S/O, cargo receipt, a
 *               finalised load plan (sea), the sent advise, the BL drafted,
 *               approved and issued (sea), the departure and the arrival
 *               confirmed, and a pre-alert to the agent (sea, past months) —
 *               so the status the Booking List shows is one the records
 *               behind it bear out. Air ends at the advise, as the BL Draft
 *               sheets are "Only for Outbound shipment-Sea"
 *   money in    Transaction → Income receives the invoices — FCL at a better
 *               bank rate (exchange gain), Air at a worse one (loss), one Air
 *               invoice only half paid; this month's are still outstanding
 *   money out   Transaction → Expense pays the carriers, agents and vendors;
 *               rent, salaries, utilities, internet and mobile, software and
 *               bank charges from the bank; fuel, stationery, meals and TA-DA
 *               from petty cash
 *   transfers   Transaction → Internal Transfer tops up petty cash
 *   journals    depreciation monthly; income tax provision and fixed-deposit
 *               interest quarterly; one customer discount
 *
 * Plus, this month: a booking waiting on Awaiting Freight Inv and a draft
 * invoice, so the next step of the loop can be tried by hand.
 *
 * Every business code starts DEMO-ACC-, and clearAccounts removes exactly
 * those rows — and refuses, naming them, if somebody's own work is built on
 * them.
 */

export const ACC = 'DEMO-ACC-';

const D = (v: Prisma.Decimal.Value): Prisma.Decimal => new Prisma.Decimal(v);
const ZERO = D(0);
/** As lib/debit-invoice toBase: four places, the way the invoice stores it. */
const toBase = (amount: Prisma.Decimal, rate: Prisma.Decimal): Prisma.Decimal => amount.times(rate).toDecimalPlaces(4);
const DAY = 86_400_000;

/** ISO 6346 — the Container Load Plan screen checks a container number's last digit. */
export function containerNo(owner: string, serial: number): string {
  const body = `${owner}U${String(serial).padStart(6, '0')}`;
  const value: Record<string, number> = {};
  let n = 10;
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (n % 11 === 0) n += 1;
    value[c] = n;
    n += 1;
  }
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const ch = body[i]!;
    sum += (/\d/.test(ch) ? Number(ch) : value[ch]!) * 2 ** i;
  }
  return `${body}${(sum % 11) % 10}`;
}

// ------------------------------------------------------------------- clear

/**
 * Removes the accounts demo, children first. Runs inside the main demo clear
 * as well, before the bookings it hangs off are removed.
 */
export async function clearAccounts(prisma: PrismaClient, tenantId: bigint, prefix: string): Promise<void> {
  const t = { tenantId };
  const demo = { startsWith: prefix };

  const invoices = (await prisma.debitInvoice.findMany({ where: { ...t, code: demo }, select: { id: true } })).map((r) => r.id);
  const entries = (await prisma.journalEntry.findMany({ where: { ...t, code: demo }, select: { id: true } })).map((r) => r.id);

  // Somebody's own work on top of the demo stops the clear, before anything moves.
  const [receipts, payments, invoicesOnDemo, linesOnDemoBank] = await Promise.all([
    prisma.debitInvoiceReceipt.findMany({
      where: { ...t, deletedAt: null, debitInvoiceId: { in: invoices }, journalEntry: { code: { not: demo } } },
      select: { journalEntry: { select: { code: true } }, debitInvoice: { select: { code: true } } },
    }),
    prisma.supplierPayment.findMany({
      where: { ...t, deletedAt: null, cost: { debitInvoiceId: { in: invoices } }, journalEntry: { code: { not: demo } } },
      select: { journalEntry: { select: { code: true } }, cost: { select: { debitInvoice: { select: { code: true } } } } },
    }),
    prisma.debitInvoice.findMany({
      where: {
        ...t,
        deletedAt: null,
        code: { not: demo },
        OR: [{ shipment: { code: demo } }, { customer: { code: demo } }],
      },
      select: { code: true },
    }),
    prisma.journalLine.findMany({
      where: { ...t, deletedAt: null, ledgerAccount: { code: demo }, journalEntry: { code: { not: demo } } },
      select: { journalEntry: { select: { code: true } } },
    }),
  ]);
  const blocking = [
    ...receipts.map((r) => `  ${r.journalEntry?.code ?? 'a voucher'} — receives demo invoice ${r.debitInvoice.code}`),
    ...payments.map((p) => `  ${p.journalEntry.code} — pays a cost on demo invoice ${p.cost.debitInvoice.code}`),
    ...invoicesOnDemo.map((i) => `  ${i.code} — debit invoice on a demo booking or customer`),
    ...linesOnDemoBank.map((l) => `  ${l.journalEntry.code} — posts to the demo bank account`),
  ];
  if (blocking.length > 0) {
    throw new Error(
      'Cannot remove the accounts demo — this work of yours is built on it:' +
        `\n${[...new Set(blocking)].join('\n')}\n\n` +
        'Cancel or delete those first, or leave the demo data in place. Nothing has been changed.',
    );
  }

  await prisma.debitInvoiceReceipt.deleteMany({ where: { ...t, OR: [{ journalEntryId: { in: entries } }, { debitInvoiceId: { in: invoices } }] } });
  await prisma.supplierPayment.deleteMany({
    where: { ...t, OR: [{ journalEntryId: { in: entries } }, { cost: { debitInvoiceId: { in: invoices } } }] },
  });
  await prisma.openingSettlement.deleteMany({ where: { ...t, journalEntryId: { in: entries } } });
  await prisma.journalLine.deleteMany({ where: { ...t, journalEntryId: { in: entries } } });
  await prisma.journalEntry.deleteMany({ where: { ...t, id: { in: entries } } });

  await prisma.debitInvoiceCostLine.deleteMany({ where: { ...t, cost: { debitInvoiceId: { in: invoices } } } });
  await prisma.debitInvoiceCost.deleteMany({ where: { ...t, debitInvoiceId: { in: invoices } } });
  await prisma.debitInvoiceLine.deleteMany({ where: { ...t, debitInvoiceId: { in: invoices } } });
  await prisma.debitInvoice.deleteMany({ where: { ...t, id: { in: invoices } } });

  await prisma.bankAccount.deleteMany({ where: { ...t, code: demo } });
  await prisma.ledgerAccount.deleteMany({ where: { ...t, code: demo } });
  await prisma.bank.deleteMany({ where: { ...t, code: demo } });

  // The vendors are this part's alone — the rest of the demo makes none —
  // and only a clear that covers this part may take them.
  if (ACC.startsWith(prefix)) {
    await prisma.vendorPic.deleteMany({ where: { ...t, vendor: { code: { startsWith: ACC } } } });
    await prisma.vendor.deleteMany({ where: { ...t, code: { startsWith: ACC } } });
  }
}

// -------------------------------------------------------------------- seed

interface Line {
  costHeadId: bigint;
  costHeadName: string;
  unitId: bigint;
  unitName: string;
  containerSizeId?: bigint;
  containerSizeName?: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
}

interface CostBlock {
  party: 'CARRIER' | 'AGENT' | 'VENDOR';
  partyId: bigint;
  supplierInvoiceNo: string;
  currency: 'USD' | 'BDT';
  rate: Prisma.Decimal;
  lines: Line[];
}

/** A customer's goods: the commodity, and what one carton measures (cm) and weighs (kg). */
interface Goods {
  item: { id: bigint; name: string; hsCode: string | null };
  style: string;
  carton: [number, number, number];
  grossKg: number | string;
  netKg: number | string;
  pcs: number;
}

/** One PO's cartons on a booking — for FCL, one container's worth. */
interface Cargo {
  ctn: number;
  carton: [number, number, number];
  grossKg: Prisma.Decimal;
  netKg: Prisma.Decimal;
  pcs: number;
}

export async function seedAccounts(prisma: PrismaClient, tenantId: bigint): Promise<string[]> {
  const t = { tenantId };
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);

  // ----------------------------------------------------------- the masters
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { currencyId: true } });
  const usd = await prisma.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'USD' } }, select: { id: true } });
  const bdt = await prisma.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'BDT' } }, select: { id: true } });
  if (tenant.currencyId !== bdt.id) {
    console.log('  (this workspace\'s base currency is not BDT — the demo figures assume it is)');
  }
  const port = async (code: string) => (await prisma.port.findFirstOrThrow({ where: { tenantId: null, portCode: code }, select: { id: true } })).id;
  const [ctg, ham, rtm, dac, dxb] = await Promise.all([port('BDCGP'), port('DEHAM'), port('NLRTM'), port('DAC'), port('DXB')]);
  const carrier = async (name: string) => (await prisma.carrier.findFirstOrThrow({ where: { tenantId: null, name }, select: { id: true } })).id;
  const [cmaCgm, emirates] = await Promise.all([carrier('CMA CGM'), carrier('Emirates SkyCargo')]);
  const unit = async (name: string) => (await prisma.costUnit.findFirstOrThrow({ where: { tenantId: null, name }, select: { id: true } })).id;
  const [uContainer, uHbl, uCbm, uKg, uTrip] = await Promise.all([unit('Container'), unit('HBL'), unit('CBM'), unit('KG'), unit('Trip')]);
  const boxSize = (code: string) =>
    prisma.containerSize.findFirstOrThrow({ where: { tenantId: null, code }, select: { id: true, name: true } });
  const [std20, hc40] = [await boxSize('20STD'), await boxSize('40HC')];
  const size20 = std20.id;
  const mode = async (code: string) => (await prisma.mode.findFirstOrThrow({ where: { tenantId: null, code }, select: { id: true } })).id;
  const [cyCy, cfsCfs] = [await mode('CY/CY'), await mode('CFS/CFS')];
  const source = (await prisma.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } })).id;
  const vendorType = async (name: string) =>
    (await prisma.vendorType.findFirstOrThrow({ where: { tenantId: null, name }, select: { id: true } })).id;

  // The main demo's CS officer does the operations work; a workspace with only
  // this part of the demo falls back on its superadmin.
  const staff = (
    (await prisma.user.findFirst({ where: { ...t, code: 'DEMO-USR-3', deletedAt: null }, select: { id: true } })) ??
    (await prisma.user.findFirstOrThrow({ where: { ...t, isSuperadmin: true }, orderBy: { id: 'asc' }, select: { id: true } }))
  ).id;

  const sector = async (n: number, name: string) =>
    (await prisma.industrySector.create({ data: { ...t, code: `${ACC}ISC-${n}`, name: `${name} (accounts demo)` }, select: { id: true } })).id;
  const [garments, leather, pharma] = [
    await sector(1, 'Garments & Textiles'),
    await sector(2, 'Leather Goods'),
    await sector(3, 'Pharmaceuticals'),
  ];
  const OFFICE = 'Agrabad C/A, Chattogram';
  const customer = async (n: number, name: string, type: 'EXPORTER' | 'IMPORTER', email: string, industrySectorId: bigint) => {
    const c = await prisma.customer.create({
      data: { ...t, code: `${ACC}CUS-${n}`, name, country: 'Bangladesh', address: OFFICE, customerType: type, businessArea: 'OUTBOUND', industrySectorId },
      select: { id: true, name: true },
    });
    await prisma.customerPic.create({ data: { ...t, code: `${ACC}CUP-${n}`, customerId: c.id, name: 'Accounts desk', email } });
    return { ...c, email };
  };
  const meghna = await customer(1, 'Meghna Knitwear Ltd', 'EXPORTER', 'accounts@meghna-knit.demo', garments);
  const padma = await customer(2, 'Padma Leather Goods', 'EXPORTER', 'finance@padma-leather.demo', leather);
  const rupsha = await customer(3, 'Rupsha Pharmaceuticals', 'EXPORTER', 'export@rupsha-pharma.demo', pharma);
  const jamuna = await customer(4, 'Jamuna Denim Ltd', 'EXPORTER', 'shipping@jamuna-denim.demo', garments);

  const item = (n: number, industrySectorId: bigint, name: string, hsCode: string) =>
    prisma.commodityItem.create({
      data: { ...t, code: `${ACC}CI-${n}`, industrySectorId, name, hsCode },
      select: { id: true, name: true, hsCode: true },
    });
  const knit: Goods = { item: await item(1, garments, 'Knitted T-Shirts', '6109.10'), style: 'KTS', carton: [50, 40, 30], grossKg: 12, netKg: '10.5', pcs: 24 };
  const denim: Goods = { item: await item(2, garments, 'Denim Trousers', '6203.42'), style: 'DNT', carton: [60, 40, 30], grossKg: 18, netKg: '16.5', pcs: 20 };
  const handbags: Goods = { item: await item(3, leather, 'Leather Handbags', '4202.21'), style: 'LHB', carton: [50, 40, 50], grossKg: 14, netKg: '12.5', pcs: 12 };
  const tablets: Goods = { item: await item(4, pharma, 'Pharmaceutical Tablets', '3004.90'), style: 'TAB', carton: [40, 30, 30], grossKg: 15, netKg: '13.5', pcs: 100 };

  /** The consignee at each destination — the importer, and who the BL notifies. */
  const consigneeAt = (pod: bigint): { name: string; address: string } =>
    pod === ham
      ? { name: 'Nordwind Retail GmbH', address: 'Spitalerstrasse 12, 20095 Hamburg, Germany' }
      : pod === rtm
        ? { name: 'Van Dijk Fashion B.V.', address: 'Wilhelminakade 91, 3072 AP Rotterdam, Netherlands' }
        : { name: 'Gulf Medical Supplies LLC', address: 'Dubai Healthcare City, Dubai, UAE' };

  // Vessels are a workspace's own, so the demo brings CMA CGM's.
  const vessel = (n: number, name: string) =>
    prisma.vessel.create({ data: { ...t, code: `${ACC}VSL-${n}`, name, carrierId: cmaCgm }, select: { id: true, name: true } });
  const vessels = [await vessel(1, 'CMA CGM Karnaphuli'), await vessel(2, 'CMA CGM Sundarbans')];

  const agent = await prisma.agent.create({
    data: { ...t, code: `${ACC}AGT-1`, name: 'Hanse Logistics GmbH', country: 'Germany', agentType: 'EXCLUSIVE' },
    select: { id: true },
  });
  const agentEmail = 'import@hanse-logistics.demo';
  await prisma.agentPic.create({ data: { ...t, code: `${ACC}AGP-1`, agentId: agent.id, name: 'Import desk', email: agentEmail } });
  // Both sea destinations, so the Pre-Alert screen offers it for them.
  await prisma.agentPortCoverage.createMany({ data: [ham, rtm].map((portId) => ({ ...t, agentId: agent.id, portId })) });
  const vendor = async (n: number, name: string, type: string) =>
    (
      await prisma.vendor.create({
        data: { ...t, code: `${ACC}VEN-${n}`, name, country: 'Bangladesh', vendorTypeId: await vendorType(type) },
        select: { id: true },
      })
    ).id;
  const lclConsol = await vendor(1, 'Shah Amanat LCL Consolidators', 'LCL');
  const transport = await vendor(2, 'Karnaphuli CFS & Transport', 'Warehouse');

  const head = async (n: number, name: string, unitId: bigint) =>
    (await prisma.costHead.create({ data: { ...t, code: `${ACC}CH-${n}`, category: 'SERVICE', name, unitId }, select: { id: true } })).id;
  const H = {
    oceanFreight: await head(1, 'Ocean Freight', uContainer),
    blFee: await head(2, 'B/L Fee', uHbl),
    lclFreight: await head(3, 'LCL Freight', uCbm),
    airFreight: await head(4, 'Air Freight', uKg),
    handling: await head(5, 'Agent Handling', uHbl),
    trucking: await head(6, 'Trucking', uTrip),
  };

  // ------------------------------------------------------------- the books
  await ensureChart(prisma as unknown as TenantDb, tenantId, null);
  const accounts = await prisma.ledgerAccount.findMany({ where: { ...t, systemKey: { not: null } }, select: { id: true, systemKey: true } });
  const acct = (key: string): bigint => {
    const found = accounts.find((a) => a.systemKey === key);
    if (found === undefined) throw new Error(`The chart has no ${key}.`);
    return found.id;
  };

  const bank = await prisma.bank.create({
    data: { ...t, code: `${ACC}BNK-1`, bankName: 'Bank Asia Ltd', branch: 'Agrabad', bankAddress: 'Agrabad C/A, Chattogram', swiftNo: 'BALBBDDH', routingNo: '070151007' },
    select: { id: true },
  });
  const clash = await prisma.ledgerAccount.findFirst({
    where: { ...t, parentId: acct('ASSET.BANK'), name: { equals: 'Bank Asia Ltd-801', mode: 'insensitive' }, deletedAt: null },
    select: { id: true },
  });
  const bankLedger = await prisma.ledgerAccount.create({
    data: {
      ...t,
      code: `${ACC}LA-1`,
      accountType: 'ASSET',
      parentId: acct('ASSET.BANK'),
      name: clash === null ? 'Bank Asia Ltd-801' : 'Bank Asia Ltd-0863303387801 (demo)',
    },
    select: { id: true },
  });
  await prisma.bankAccount.create({
    data: { ...t, code: `${ACC}BAC-1`, accountName: 'Operating account', accountNo: '0863303387801', bankId: bank.id, ledgerAccountId: bankLedger.id },
  });
  const BANK = bankLedger.id;
  const CASH = acct('ASSET.CASH.ON_HAND');

  // ------------------------------------------------------------ the helpers
  const counters: Record<string, number> = {};
  const next = (kind: string) => (counters[kind] = (counters[kind] ?? 0) + 1);

  /** The day `day` of the month `m` months back, or null when it is still to come. */
  const dateIn = (m: number, day: number): Date | null => {
    const y = now.getUTCFullYear();
    const mo = now.getUTCMonth() - m;
    const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const d = new Date(Date.UTC(y, mo, Math.min(day, last)));
    return d.toISOString().slice(0, 10) > todayIso ? null : d;
  };
  const monthName = (d: Date) => d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  /** A voucher as the Transaction screens write one: drafted, given its lines, posted. */
  const voucher = async (args: {
    kind: 'JOURNAL' | 'EXPENSE' | 'INCOME' | 'TRANSFER';
    date: Date;
    description: string;
    lines: { account: bigint; debit?: Prisma.Decimal; credit?: Prisma.Decimal }[];
    party?: { type: 'CUSTOMER' | 'AGENT' | 'CARRIER' | 'VENDOR'; id: bigint };
  }): Promise<bigint> => {
    const prefixOf = { JOURNAL: 'JV', EXPENSE: 'PV', INCOME: 'RV', TRANSFER: 'TV' } as const;
    const total = args.lines.reduce((s, l) => s.plus(l.debit ?? ZERO), ZERO);
    const partyColumns =
      args.party === undefined
        ? {}
        : {
            partyType: args.party.type,
            ...(args.party.type === 'CUSTOMER'
              ? { customerId: args.party.id }
              : args.party.type === 'AGENT'
                ? { agentId: args.party.id }
                : args.party.type === 'CARRIER'
                  ? { carrierId: args.party.id }
                  : { vendorId: args.party.id }),
          };
    const entry = await prisma.journalEntry.create({
      data: {
        ...t,
        code: `${ACC}${prefixOf[args.kind]}-${String(next(args.kind)).padStart(4, '0')}`,
        seriesYear: args.date.getUTCFullYear(),
        kind: args.kind,
        entryDate: args.date,
        description: args.description,
        status: 'DRAFT',
        totalAmount: total,
        ...partyColumns,
      },
      select: { id: true },
    });
    await prisma.journalLine.createMany({
      data: args.lines.map((l, i) => ({
        ...t,
        journalEntryId: entry.id,
        sortOrder: i,
        ledgerAccountId: l.account,
        debit: l.debit ?? ZERO,
        credit: l.credit ?? ZERO,
      })),
    });
    await prisma.journalEntry.update({ where: { id: entry.id }, data: { status: 'POSTED', postedAt: args.date } });
    return entry.id;
  };
  const expense = (date: Date, description: string, from: bigint, rows: [string, number][]) =>
    voucher({
      kind: 'EXPENSE',
      date,
      description,
      lines: [
        ...rows.map(([key, amount]) => ({ account: acct(key), debit: D(amount) })),
        { account: from, credit: D(rows.reduce((s, [, a]) => s + a, 0)) },
      ],
    });

  /** `ctn` cartons of `goods`, in its own carton unless another is given. */
  const lot = (goods: Goods, ctn: number, carton: [number, number, number] = goods.carton): Cargo => ({
    ctn,
    carton,
    grossKg: D(goods.grossKg).times(ctn),
    netKg: D(goods.netKg).times(ctn),
    pcs: goods.pcs * ctn,
  });
  /** As many cartons as fill a 20' to about 27 CBM, a few short now and then. */
  const container = (goods: Goods, k: number): Cargo => {
    const [l, w, h] = goods.carton;
    return lot(goods, Math.floor(27_000_000 / (l * w * h)) - 5 * (k % 4));
  };
  /** LCL is quoted per CBM, so its cartons give that CBM back exactly: 50 × 40 × 50 is 0.1 CBM. */
  const lcl = (goods: Goods, cbm: number): Cargo => lot(goods, cbm * 10, [50, 40, 50]);
  /** Air is quoted per chargeable kg; these cartons are heavier than their volume, so that is the gross weight. */
  const air = (goods: Goods, kg: number): Cargo => ({
    ...lot(goods, Math.ceil(kg / Number(goods.grossKg))),
    grossKg: D(kg),
    netKg: D(kg).times('0.9'),
  });

  const CFS = 'Karnaphuli CFS, Chattogram';
  const AIR_TERMINAL = 'HSIA Cargo Village, Dhaka';
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const sum = <T>(rows: T[], pick: (row: T) => Prisma.Decimal | null) => rows.reduce((acc, r) => acc.plus(pick(r) ?? ZERO), ZERO);

  /**
   * Inquiry → accepted quotation → booking, then the booking taken the whole
   * way the screens take one, so its status is true: the schedule approved,
   * the S/O issued, the cargo received, packed into finalised load plans (sea:
   * a container each for FCL, one box for LCL), the advise sent and — sea only
   * — the BL drafted, approved and issued; then the departure and, once it is
   * due, the arrival confirmed.
   *
   * Dated backwards from `date`, the invoice date, so the chain has finished
   * the day before the Debit Note goes out (Menu F22: "… BL Issue > Debit
   * Note"). The invoice dates — and so every figure Accounts shows — are the
   * ones this demo has always had.
   */
  const booking = async (args: {
    date: Date;
    customer: { id: bigint; name: string };
    goods: Goods;
    type: 'SEA' | 'AIR';
    loading: 'FCL' | 'LCL' | null;
    carrierId: bigint;
    pol: bigint;
    pod: bigint;
    currency: 'USD' | 'BDT';
    rate: Prisma.Decimal;
    lines: Line[];
    cargo: Cargo[];
  }) => {
    const n = next('job');
    const sea = args.type === 'SEA';
    const at = (days: number) => new Date(args.date.getTime() + days * DAY);
    const yearOf = (d: Date) => d.getUTCFullYear();

    const quoted = at(-20);
    const booked = at(-16);
    const decided = at(-14);
    const soIssued = at(-13);
    const received = sea ? at(-8) : at(-5);
    const stuffed = at(-6);
    const cutOff = sea ? at(-6) : at(-4);
    const etd = sea ? at(-4) : at(-3);
    // Thirty days to North Europe; Dhaka to Dubai is the same day.
    const eta = sea ? at(26) : new Date(etd.getTime() + 6 * 3_600_000);
    const advised = sea ? at(-3) : at(-2);

    const vessel = vessels[n % vessels.length]!;
    const voyageNo = sea ? `V${etd.toISOString().slice(2, 10).replace(/-/g, '')}` : null;
    const flightNo = sea ? null : n % 2 === 0 ? 'EK585' : 'EK583';
    const consignee = consigneeAt(args.pod);
    const goods = args.goods.item;
    const cbmOf = (c: Cargo) => D(c.carton[0] * c.carton[1] * c.carton[2]).times(c.ctn).dividedBy(1_000_000);

    const inquiry = await prisma.inquiry.create({
      data: {
        ...t, code: `${ACC}INQ-${n}`, seriesYear: yearOf(quoted), inquiryDate: quoted, sourceId: source, shipmentType: args.type,
        customerId: args.customer.id, movementType: 'OUTBOUND', loadingType: args.loading, polId: args.pol, podId: args.pod,
        status: 'WON', createdAt: quoted,
      },
      select: { id: true },
    });
    await prisma.inquiryVolume.create({
      data:
        args.loading === 'FCL'
          ? { ...t, inquiryId: inquiry.id, volumeKind: 'FCL', containerSizeId: size20, quantity: args.cargo.length }
          : {
              ...t, inquiryId: inquiry.id, volumeKind: sea ? 'LCL' : 'AIR',
              cbm: sum(args.cargo, cbmOf), weightKg: sum(args.cargo, (c) => c.grossKg),
            },
    });
    await prisma.inquiryCommodity.create({ data: { ...t, inquiryId: inquiry.id, commodityItemId: goods.id, hsCode: goods.hsCode } });

    const quotation = await prisma.quotation.create({
      data: {
        ...t, code: `${ACC}QTN-${n}`, seriesYear: yearOf(quoted), inquiryId: inquiry.id, quotationDate: quoted, customerId: args.customer.id,
        shipmentType: args.type, movementType: 'OUTBOUND', loadingType: args.loading, polId: args.pol, podId: args.pod, carrierId: args.carrierId,
        localCurrencyId: bdt.id, conversionRate: D(args.currency === 'USD' ? args.rate : 1), status: 'ACCEPTED',
        sentAt: quoted, createdAt: quoted,
      },
      select: { id: true },
    });
    await prisma.quotationLine.createMany({
      data: args.lines.map((l, i) => ({
        ...t, quotationId: quotation.id, sortOrder: i, costHeadId: l.costHeadId, costHeadName: l.costHeadName,
        containerSizeId: l.containerSizeId ?? null, containerSizeName: l.containerSizeName ?? null,
        costUnitId: l.unitId, unitName: l.unitName, quantity: l.quantity, sellingPrice: l.unitPrice,
        currencyId: args.currency === 'USD' ? usd.id : bdt.id, currencyCode: args.currency,
        conversionRate: args.currency === 'USD' ? args.rate : D(1),
      })),
    });
    await prisma.quotationCommodity.create({
      data: { ...t, quotationId: quotation.id, commodityItemId: goods.id, commodityName: goods.name, hsCode: goods.hsCode },
    });

    const code = `${ACC}BKG-${n}`;
    // Sea only: FCL is stuffed and handed over CY to CY, LCL through the CFS.
    const modeId = args.loading === 'FCL' ? cyCy : cfsCfs;
    const shipment = await prisma.shipment.create({
      data: {
        ...t, code, seriesYear: yearOf(booked), quotationId: quotation.id, shipmentType: args.type,
        customerId: args.customer.id, exporterName: args.customer.name, exporterAddress: OFFICE,
        importerName: consignee.name, importerAddress: consignee.address,
        carrierId: args.carrierId, polId: args.pol, podId: args.pod, loadingType: args.loading, transitType: 'DIRECT',
        modeId: sea ? modeId : null, warehouseCfs: sea ? CFS : null, placeOfReceipt: sea ? CFS : null,
        etd, eta, goodsHandoverDate: received,
        // The end of each chain: sea issues the BL, air's ends at the advise.
        status: sea ? 'BL_ISSUED' : 'ADVISED',
        createdAt: booked,
      },
      select: { id: true },
    });
    const shipmentId = shipment.id;
    await prisma.shipmentCommodity.create({ data: { ...t, shipmentId, commodityItemId: goods.id, hsCode: goods.hsCode } });

    /** A PO for one lot, approved by C/S on the customer's behalf, and its cargo line. */
    const cargoLine = async (c: Cargo, i: number) => {
      const poNo = `PO-${String(n).padStart(4, '0')}-${i + 1}`;
      const po = await prisma.shipmentPo.create({
        data: { ...t, shipmentId, poNo, approvalStatus: 'APPROVED', approvedBy: staff, approvedAt: at(-15), approvedOnBehalf: true },
        select: { id: true },
      });
      const line = await prisma.shipmentCargoLine.create({
        data: {
          ...t, shipmentId, shipmentPoId: po.id, itemCode: `${args.goods.style}-${i + 1}`, sku: `${poNo}-S1`,
          ctnQty: c.ctn, pcsQty: c.pcs, netWeightKg: c.netKg, grossWeightKg: c.grossKg,
          cartonLengthCm: D(c.carton[0]), cartonWidthCm: D(c.carton[1]), cartonHeightCm: D(c.carton[2]),
        },
        select: {
          id: true, shipmentPoId: true, itemCode: true, sku: true, ctnQty: true, pcsQty: true, netWeightKg: true, grossWeightKg: true,
          cartonLengthCm: true, cartonWidthCm: true, cartonHeightCm: true, volumeCbm: true, chargeableWtKg: true,
        },
      });
      return { ...line, poNo };
    };
    const lines: Awaited<ReturnType<typeof cargoLine>>[] = [];
    for (const [i, c] of args.cargo.entries()) lines.push(await cargoLine(c, i));

    const schedule = await prisma.shipmentSchedule.create({
      data: {
        ...t, code: `${ACC}SCH-${n}`, shipmentId, carrierId: args.carrierId, transitType: 'DIRECT',
        cutOffDate: cutOff, vgmDate: sea ? cutOff : null, siDate: sea ? at(-7) : null,
        status: 'APPROVED', proposedBy: staff, proposedAt: at(-15), decidedBy: staff, decidedAt: decided, createdAt: at(-15),
      },
      select: { id: true },
    });
    await prisma.shipmentScheduleLeg.create({
      data: {
        ...t, scheduleId: schedule.id, legNo: 1, vesselId: sea ? vessel.id : null, voyageNo, flightNo,
        originPortId: args.pol, destinationPortId: args.pod, etd, eta,
      },
    });

    const soCode = `${ACC}SO-${n}`;
    const so = await prisma.shippingOrder.create({
      data: {
        ...t, code: soCode, seriesYear: yearOf(soIssued), shipmentId, scheduleId: schedule.id, issueDate: soIssued, issuedBy: staff,
        firstVesselId: sea ? vessel.id : null, firstVesselName: sea ? vessel.name : null, firstFlightNo: flightNo,
        cutOff, etd, eta, warehouseCfs: sea ? CFS : null, status: 'ISSUED', qrPayload: `SO:${soCode}\nBKG:${code}`, createdAt: soIssued,
      },
      select: { id: true },
    });

    // Every carton arrived as booked, at the CFS for sea and the cargo village for air.
    const efrNo = sea ? `EFR-A${String(n).padStart(4, '0')}` : null;
    const receipt = await prisma.cargoReceipt.create({
      data: {
        ...t, code: `${ACC}CR-${n}`, seriesYear: yearOf(received), shipmentId, shippingOrderId: so.id, receiveDate: received,
        unloadLocation: sea ? CFS : AIR_TERMINAL, efrNo, receiptSeq: 1, status: 'CONFIRMED', receivedBy: staff,
        confirmedAt: received, createdAt: received,
      },
      select: { id: true },
    });
    await prisma.cargoReceiptLine.createMany({
      data: lines.map((l) => ({
        ...t, cargoReceiptId: receipt.id, shipmentCargoLineId: l.id, receivedCtnQty: l.ctnQty, receivedPcsQty: l.pcsQty,
        receivedNetWeightKg: l.netWeightKg, receivedGrossWeightKg: l.grossWeightKg, lineStatus: 'ACCEPTED', createdAt: received,
      })),
    });

    // Sea: FCL fills a 20' per PO, LCL goes out in one 40'HC.
    const boxes = !sea ? [] : args.loading === 'FCL' ? lines.map((l) => [l]) : [lines];
    const plans: { id: bigint; containerNo: string; sealNo: string; size: string; lines: typeof lines }[] = [];
    for (const [i, box] of boxes.entries()) {
      const size = args.loading === 'FCL' ? std20 : hc40;
      const no = containerNo('CMA', 100_000 + n * 10 + i);
      const seal = `CC${700_000 + n * 10 + i}`;
      const clp = await prisma.clp.create({
        data: {
          ...t, code: `${ACC}CLP-${n}-${i + 1}`, seriesYear: yearOf(stuffed), shipmentId, shippingOrderId: so.id,
          consolidationType: 'SINGLE', containerSizeId: size.id, carrierId: args.carrierId, finalCfsLocation: CFS,
          containerNo: no, sealNo: seal, loadDatetime: stuffed, loadedBy: 'Karnaphuli CFS stuffing crew',
          status: 'FINAL', finalisedBy: staff, finalisedAt: stuffed,
          totalCtnQty: box.reduce((acc, l) => acc + l.ctnQty, 0),
          totalPcsQty: box.reduce((acc, l) => acc + (l.pcsQty ?? 0), 0),
          totalNetWeightKg: sum(box, (l) => l.netWeightKg),
          totalGrossWeightKg: sum(box, (l) => l.grossWeightKg),
          totalVolumeCbm: sum(box, (l) => l.volumeCbm),
          createdAt: at(-7),
        },
        select: { id: true },
      });
      await prisma.clpBooking.create({ data: { ...t, clpId: clp.id, shipmentId, shippingOrderId: so.id } });
      await prisma.clpLine.createMany({
        data: box.map((l) => ({
          ...t, clpId: clp.id, shipmentCargoLineId: l.id, shipmentPoId: l.shipmentPoId, poNo: l.poNo, itemCode: l.itemCode, sku: l.sku,
          cartonLengthCm: l.cartonLengthCm, cartonWidthCm: l.cartonWidthCm, cartonHeightCm: l.cartonHeightCm,
          ctnQty: l.ctnQty, pcsQty: l.pcsQty, netWeightKg: l.netWeightKg, grossWeightKg: l.grossWeightKg, volumeCbm: l.volumeCbm,
          isFinalAllocation: true,
        })),
      });
      plans.push({ id: clp.id, containerNo: no, sealNo: seal, size: size.name, lines: box });
    }

    /*
     * The advise, written as the screen writes one: a draft, the booking it
     * covers, its PO grid, then sent. The database lets a booking join a draft
     * only, so the order matters.
     */
    const houseBlNo = sea ? `${ACC}HBL-${n}` : `${ACC}HAWB-${n}`;
    const advise = await prisma.shipmentAdvise.create({
      data: {
        ...t, code: `${ACC}SA-${n}`, seriesYear: yearOf(advised), shipmentId, scheduleId: schedule.id, carrierId: args.carrierId,
        transitType: 'DIRECT', firstVesselId: sea ? vessel.id : null, voyageNo, firstFlightNo: flightNo,
        polId: args.pol, podId: args.pod, etd, eta, stuffingDate: sea ? stuffed : null,
        // The carrier's master: a CMA CGM bill, or an Emirates (176) air waybill.
        houseBlNo, mblNo: sea ? `CGP${String(4_100_000 + n)}` : `176-${String(40_000_000 + n * 7)}`,
        status: 'DRAFT', createdBy: staff, createdAt: advised,
      },
      select: { id: true },
    });
    await prisma.shipmentAdviseBooking.create({ data: { ...t, adviseId: advise.id, shipmentId, createdBy: staff, createdAt: advised } });
    await prisma.shipmentAdviseLine.createMany({
      data: lines.map((l) => ({
        ...t, adviseId: advise.id, shipmentId, shipmentPoId: l.shipmentPoId, shipmentCargoLineId: l.id,
        clpId: plans.find((p) => p.lines.includes(l))?.id ?? null,
        poNo: l.poNo, itemCode: l.itemCode, sku: l.sku, ctnQty: l.ctnQty, pcsQty: l.pcsQty,
        netWeightKg: l.netWeightKg, grossWeightKg: l.grossWeightKg,
        cartonLengthCm: l.cartonLengthCm, cartonWidthCm: l.cartonWidthCm, cartonHeightCm: l.cartonHeightCm,
        volumeCbm: l.volumeCbm, chargeableWtKg: sea ? null : l.chargeableWtKg,
        cargoReceiptDate: received, stuffingDate: sea ? stuffed : null, efrNo,
      })),
    });
    const ctn = lines.reduce((acc, l) => acc + l.ctnQty, 0);
    const gross = sum(lines, (l) => l.grossWeightKg);
    const cbm = sum(lines, (l) => l.volumeCbm);
    await prisma.shipmentAdvise.update({
      where: { id: advise.id },
      data: {
        status: 'SENT', sentAt: advised, sentBy: staff,
        totalPoCount: lines.length, totalCtnQty: ctn, totalPcsQty: lines.reduce((acc, l) => acc + (l.pcsQty ?? 0), 0),
        totalNetWeightKg: sum(lines, (l) => l.netWeightKg), totalGrossWeightKg: gross, totalVolumeCbm: cbm,
        totalChargeableWtKg: sea ? null : sum(lines, (l) => l.chargeableWtKg),
      },
    });

    if (sea) {
      // Drafted from the advise, approved, then issued on BL Print with three originals.
      const party = `${consignee.name}\n${consignee.address}`;
      const bl = await prisma.blDraft.create({
        data: {
          ...t, code: `${ACC}BL-${n}`, seriesYear: yearOf(advised), shipmentId, adviseId: advise.id, origin: 'STAFF', blNo: houseBlNo,
          shipperText: `${args.customer.name}\n${OFFICE}`, consigneeText: party, notifyText: party,
          pointCountryOfOrigin: 'Bangladesh', preCarriageByModeId: modeId, placeOfReceipt: CFS,
          oceanVesselVoyage: `${vessel.name} / ${voyageNo}`, polId: args.pol, podId: args.pod,
          packagesDescription: `${ctn} CARTONS\n${goods.name.toUpperCase()}\nHS CODE ${goods.hsCode ?? ''}`.trim(),
          grossWeightKg: gross, measurementCbm: cbm, freightPayableAt: 'Chattogram', originalBlCount: 3, ladenOnBoardDate: etd,
          status: 'APPROVED', approvedAt: at(-2), approvedBy: staff, issuedAt: at(-1), issuedBy: staff,
          createdBy: staff, createdAt: advised,
        },
        select: { id: true },
      });
      await prisma.blDraftContainer.createMany({
        data: plans.map((p) => ({
          ...t, blDraftId: bl.id, clpId: p.id, containerNo: p.containerNo, containerSize: p.size, sealNo: p.sealNo,
          ctnQty: p.lines.reduce((acc, l) => acc + l.ctnQty, 0),
          grossWeightKg: sum(p.lines, (l) => l.grossWeightKg), measurementCbm: sum(p.lines, (l) => l.volumeCbm),
          createdBy: staff,
        })),
      });
    }

    // Depart-Arrive Confirmation: sailed on its ETD; arrived once the ETA has come.
    const confirm = (kind: 'DEPARTED' | 'ARRIVED', on: Date) =>
      prisma.shipmentMilestone.create({
        data: { ...t, shipmentId, kind, pulledOn: on, confirmedOn: on, confirmedBy: staff, confirmedAt: on, createdBy: staff, createdAt: on },
      });
    await confirm('DEPARTED', etd);
    if (eta <= now) await confirm('ARRIVED', eta);

    // The agent was pre-alerted with the HBL for every sea job before this month.
    if (sea && args.date < monthStart) {
      await prisma.preAlert.create({
        data: {
          ...t, shipmentId, agentId: agent.id, toAddresses: [agentEmail], documents: ['HBL'],
          sentBy: staff, sentAt: args.date, createdBy: staff, createdAt: args.date,
        },
      });
    }

    return { quotationId: quotation.id, shipmentId, code };
  };

  /** Debit Invoice with its Selling Price grid and its Buying from … blocks, totals as retotalInvoice keeps them. */
  const invoice = async (args: {
    date: Date;
    job: { quotationId: bigint; shipmentId: bigint };
    customer: { id: bigint; email: string };
    currency: 'USD' | 'BDT';
    rate: Prisma.Decimal;
    lines: Line[];
    costs: CostBlock[];
    status?: 'ISSUED' | 'DRAFT';
  }) => {
    const issued = (args.status ?? 'ISSUED') === 'ISSUED';
    const sell = args.lines.map((l) => l.quantity.times(l.unitPrice));
    const total = sell.reduce((s, a) => s.plus(a), ZERO);
    const totalBase = sell.reduce((s, a) => s.plus(toBase(a, args.rate)), ZERO);
    const blocks = args.costs.map((c) => {
      const amounts = c.lines.map((l) => l.quantity.times(l.unitPrice));
      return {
        ...c,
        total: amounts.reduce((s, a) => s.plus(a), ZERO),
        totalBase: amounts.reduce((s, a) => s.plus(toBase(a, c.rate)), ZERO),
      };
    });
    const created = await prisma.debitInvoice.create({
      data: {
        ...t,
        code: `${ACC}DN-${String(next('invoice')).padStart(4, '0')}`,
        seriesYear: args.date.getUTCFullYear(),
        kind: 'FREIGHT',
        shipmentId: args.job.shipmentId,
        quotationId: args.job.quotationId,
        customerId: args.customer.id,
        invoiceDate: args.date,
        currencyId: args.currency === 'USD' ? usd.id : bdt.id,
        currencyCode: args.currency,
        conversionRate: args.rate,
        totalAmount: total,
        totalAmountBase: totalBase,
        costTotalBase: blocks.reduce((s, b) => s.plus(b.totalBase), ZERO),
        recipientEmails: [args.customer.email],
        status: issued ? 'ISSUED' : 'DRAFT',
        ...(issued ? { issuedAt: args.date, sentAt: args.date } : {}),
      },
      select: { id: true, code: true },
    });
    await prisma.debitInvoiceLine.createMany({
      data: args.lines.map((l, i) => ({
        ...t, debitInvoiceId: created.id, sortOrder: i, costHeadId: l.costHeadId, costHeadName: l.costHeadName,
        containerSizeId: l.containerSizeId ?? null, containerSizeName: l.containerSizeName ?? null,
        costUnitId: l.unitId, unitName: l.unitName, quantity: l.quantity, unitPrice: l.unitPrice,
      })),
    });
    const costs: { id: bigint; party: CostBlock['party']; partyId: bigint; total: Prisma.Decimal; totalBase: Prisma.Decimal; rate: Prisma.Decimal }[] = [];
    for (const [i, b] of blocks.entries()) {
      const cost = await prisma.debitInvoiceCost.create({
        data: {
          ...t, debitInvoiceId: created.id, sortOrder: i, partyType: b.party,
          ...(b.party === 'CARRIER' ? { carrierId: b.partyId } : b.party === 'AGENT' ? { agentId: b.partyId } : { vendorId: b.partyId }),
          supplierInvoiceNo: b.supplierInvoiceNo, currencyId: b.currency === 'USD' ? usd.id : bdt.id, currencyCode: b.currency,
          conversionRate: b.rate, totalAmount: b.total, totalAmountBase: b.totalBase,
        },
        select: { id: true },
      });
      await prisma.debitInvoiceCostLine.createMany({
        data: b.lines.map((l, j) => ({
          ...t, debitInvoiceCostId: cost.id, sortOrder: j, costHeadId: l.costHeadId, costHeadName: l.costHeadName,
          containerSizeId: l.containerSizeId ?? null, containerSizeName: l.containerSizeName ?? null,
          costUnitId: l.unitId, unitName: l.unitName, quantity: l.quantity, unitPrice: l.unitPrice,
        })),
      });
      costs.push({ id: cost.id, party: b.party, partyId: b.partyId, total: b.total, totalBase: b.totalBase, rate: b.rate });
    }
    return { id: created.id, code: created.code, total, totalBase, rate: args.rate, costs };
  };

  /** Transaction → Income against an invoice: the bank in, the service income out, and the receipt. */
  const receive = async (args: {
    date: Date;
    inv: { id: bigint; code: string; total: Prisma.Decimal; totalBase: Prisma.Decimal; rate: Prisma.Decimal };
    customer: { id: bigint; name: string };
    serviceKey: string;
    share: number;
    bankRate: Prisma.Decimal;
    received?: Prisma.Decimal;
  }) => {
    const amount = args.inv.total.times(args.share).toDecimalPlaces(4);
    const closes = args.share === 1;
    const cash = toBase(amount, args.bankRate);
    const entry = await voucher({
      kind: 'INCOME',
      date: args.date,
      description: `Received against ${args.inv.code} from ${args.customer.name}`,
      party: { type: 'CUSTOMER', id: args.customer.id },
      lines: [
        { account: BANK, debit: cash },
        { account: acct(args.serviceKey), credit: cash },
      ],
    });
    await prisma.debitInvoiceReceipt.create({
      data: {
        ...t, debitInvoiceId: args.inv.id, journalEntryId: entry, paymentDate: args.date, amount,
        amountBase: closes ? args.inv.totalBase.minus(args.received ?? ZERO) : toBase(amount, args.inv.rate),
      },
    });
  };

  /** Transaction → Expense against a supplier's cost block. */
  const pay = async (args: {
    date: Date;
    cost: { id: bigint; party: CostBlock['party']; partyId: bigint; total: Prisma.Decimal; totalBase: Prisma.Decimal };
    invCode: string;
    serviceKey: string;
    bankRate: Prisma.Decimal;
    who: string;
  }) => {
    const cash = toBase(args.cost.total, args.bankRate);
    const entry = await voucher({
      kind: 'EXPENSE',
      date: args.date,
      description: `Paid ${args.who} for ${args.invCode}`,
      party: { type: args.cost.party, id: args.cost.partyId },
      lines: [
        { account: acct(args.serviceKey), debit: cash },
        { account: BANK, credit: cash },
      ],
    });
    await prisma.supplierPayment.create({
      data: {
        ...t, journalEntryId: entry, debitInvoiceCostId: args.cost.id, paymentDate: args.date,
        amount: args.cost.total, amountBase: args.cost.totalBase,
      },
    });
  };

  // ---------------------------------------------------------- the opening
  const MONTHS = 22;
  const first = dateIn(MONTHS - 1, 1)!;
  await voucher({
    kind: 'JOURNAL',
    date: first,
    description: 'Opening capital introduced by the owners',
    lines: [
      { account: BANK, debit: D(6_000_000) },
      { account: CASH, debit: D(50_000) },
      { account: acct('EQUITY.OWNER.INVESTMENT'), credit: D(6_050_000) },
    ],
  });

  // ------------------------------------------------------------ the months
  for (let m = MONTHS - 1; m >= 0; m -= 1) {
    const grow = D(1).plus(D(MONTHS - 1 - m).times('0.02'));
    const usdRate = D('121.00').plus(D(m % 5).times('0.40'));
    const month = monthName(dateIn(m, 1)!);

    /*
     * Seven jobs a month: three FCL and two LCL out of Chattogram, two Air out
     * of Dhaka. FCL is received at a better bank rate than invoiced (an
     * exchange gain), Air at a worse one (a loss), LCL is in taka; and last
     * month's first Air invoice is only half paid.
     */
    const specs: {
      kind: 'FCL' | 'LCL' | 'AIR';
      customer: { id: bigint; name: string; email: string };
      goods: Goods;
      day: number;
      pod: bigint;
      units: number;
      sell: Prisma.Decimal.Value;
      cost: Prisma.Decimal.Value;
    }[] = [
      { kind: 'FCL', customer: meghna, goods: knit, day: 1, pod: ham, units: 2 + (m % 3), sell: 1700, cost: 1180 },
      { kind: 'FCL', customer: jamuna, goods: denim, day: 2, pod: ham, units: 3 + (m % 2), sell: 1650, cost: 1150 },
      { kind: 'FCL', customer: meghna, goods: knit, day: 3, pod: rtm, units: 1 + (m % 2), sell: 1750, cost: 1220 },
      { kind: 'LCL', customer: padma, goods: handbags, day: 2, pod: ham, units: 8 + (m % 5), sell: 4300, cost: 3300 },
      { kind: 'LCL', customer: jamuna, goods: denim, day: 3, pod: rtm, units: 5 + (m % 3), sell: 4400, cost: 3300 },
      { kind: 'AIR', customer: rupsha, goods: tablets, day: 1, pod: dxb, units: 600 + 50 * (m % 4), sell: '2.95', cost: '2.30' },
      { kind: 'AIR', customer: rupsha, goods: tablets, day: 3, pod: dxb, units: 400 + 30 * (m % 3), sell: '3.05', cost: '2.35' },
    ];

    let firstAir = true;
    for (const spec of specs) {
      const date = dateIn(m, spec.day);
      if (date === null) continue;
      const qty = D(spec.units);
      const sellAt = D(spec.sell).times(grow).toDecimalPlaces(2);
      const costAt = D(spec.cost).times(grow).toDecimalPlaces(2);

      if (spec.kind === 'FCL') {
        const box = { unitId: uContainer, unitName: 'Container', containerSizeId: size20, containerSizeName: '20STD' };
        const lines: Line[] = [
          { costHeadId: H.oceanFreight, costHeadName: 'Ocean Freight', ...box, quantity: qty, unitPrice: sellAt },
          { costHeadId: H.blFee, costHeadName: 'B/L Fee', unitId: uHbl, unitName: 'HBL', quantity: D(1), unitPrice: D(50) },
        ];
        const cargo = Array.from({ length: spec.units }, (_, k) => container(spec.goods, m + k));
        const job = await booking({ date, customer: spec.customer, goods: spec.goods, type: 'SEA', loading: 'FCL', carrierId: cmaCgm, pol: ctg, pod: spec.pod, currency: 'USD', rate: usdRate, lines, cargo });
        const inv = await invoice({
          date, job, customer: spec.customer, currency: 'USD', rate: usdRate, lines,
          costs: [
            { party: 'CARRIER', partyId: cmaCgm, supplierInvoiceNo: `CMA-${job.code.slice(-4)}`, currency: 'USD', rate: usdRate, lines: [{ costHeadId: H.oceanFreight, costHeadName: 'Ocean Freight', ...box, quantity: qty, unitPrice: costAt }] },
            { party: 'AGENT', partyId: agent.id, supplierInvoiceNo: `HANSE-${job.code.slice(-4)}`, currency: 'USD', rate: usdRate, lines: [{ costHeadId: H.handling, costHeadName: 'Agent Handling', unitId: uHbl, unitName: 'HBL', quantity: D(1), unitPrice: D(120) }] },
            { party: 'VENDOR', partyId: transport, supplierInvoiceNo: `KCT-${job.code.slice(-4)}`, currency: 'BDT', rate: D(1), lines: [{ costHeadId: H.trucking, costHeadName: 'Trucking', unitId: uTrip, unitName: 'Trip', quantity: qty, unitPrice: D(6000) }] },
          ],
        });
        const recv = dateIn(m, 18);
        if (m >= 1 && recv !== null) await receive({ date: recv, inv, customer: spec.customer, serviceKey: 'INCOME.SERVICE.SEA_FCL', share: 1, bankRate: usdRate.plus('0.50') });
        const [carrierCost, agentCost, vendorCost] = inv.costs;
        const p1 = dateIn(m, 14);
        if (m >= 1 && p1 !== null) await pay({ date: p1, cost: carrierCost!, invCode: inv.code, serviceKey: 'EXPENSE.COST_OF_SERVICE.SEA_FCL', bankRate: usdRate.minus('0.20'), who: 'CMA CGM' });
        const p2 = dateIn(m, 25);
        if (m >= 2 && p2 !== null) await pay({ date: p2, cost: agentCost!, invCode: inv.code, serviceKey: 'EXPENSE.COST_OF_SERVICE.SEA_FCL', bankRate: usdRate, who: 'Hanse Logistics GmbH' });
        const p3 = dateIn(m, 10);
        if (m >= 1 && p3 !== null) await pay({ date: p3, cost: vendorCost!, invCode: inv.code, serviceKey: 'EXPENSE.COST_OF_SERVICE.SEA_FCL', bankRate: D(1), who: 'Karnaphuli CFS & Transport' });
      } else if (spec.kind === 'LCL') {
        const lines: Line[] = [
          { costHeadId: H.lclFreight, costHeadName: 'LCL Freight', unitId: uCbm, unitName: 'CBM', quantity: qty, unitPrice: sellAt.toDecimalPlaces(0) },
          { costHeadId: H.blFee, costHeadName: 'B/L Fee', unitId: uHbl, unitName: 'HBL', quantity: D(1), unitPrice: D(2500) },
        ];
        const job = await booking({ date, customer: spec.customer, goods: spec.goods, type: 'SEA', loading: 'LCL', carrierId: cmaCgm, pol: ctg, pod: spec.pod, currency: 'BDT', rate: D(1), lines, cargo: [lcl(spec.goods, spec.units)] });
        const inv = await invoice({
          date, job, customer: spec.customer, currency: 'BDT', rate: D(1), lines,
          costs: [{ party: 'VENDOR', partyId: lclConsol, supplierInvoiceNo: `SALC-${job.code.slice(-4)}`, currency: 'BDT', rate: D(1), lines: [{ costHeadId: H.lclFreight, costHeadName: 'LCL Freight', unitId: uCbm, unitName: 'CBM', quantity: qty, unitPrice: costAt.toDecimalPlaces(0) }] }],
        });
        const recv = dateIn(m, 20);
        if (m >= 1 && recv !== null) await receive({ date: recv, inv, customer: spec.customer, serviceKey: 'INCOME.SERVICE.SEA_LCL', share: 1, bankRate: D(1) });
        const p1 = dateIn(m, 12);
        if (m >= 1 && p1 !== null) await pay({ date: p1, cost: inv.costs[0]!, invCode: inv.code, serviceKey: 'EXPENSE.COST_OF_SERVICE.SEA_LCL', bankRate: D(1), who: 'Shah Amanat LCL Consolidators' });
      } else {
        const lines: Line[] = [{ costHeadId: H.airFreight, costHeadName: 'Air Freight', unitId: uKg, unitName: 'KG', quantity: qty, unitPrice: sellAt }];
        const job = await booking({ date, customer: spec.customer, goods: spec.goods, type: 'AIR', loading: null, carrierId: emirates, pol: dac, pod: spec.pod, currency: 'USD', rate: usdRate, lines, cargo: [air(spec.goods, spec.units)] });
        const inv = await invoice({
          date, job, customer: spec.customer, currency: 'USD', rate: usdRate, lines,
          costs: [
            { party: 'CARRIER', partyId: emirates, supplierInvoiceNo: `EK-${job.code.slice(-4)}`, currency: 'USD', rate: usdRate, lines: [{ costHeadId: H.airFreight, costHeadName: 'Air Freight', unitId: uKg, unitName: 'KG', quantity: qty, unitPrice: costAt }] },
            { party: 'VENDOR', partyId: transport, supplierInvoiceNo: `KCT-${job.code.slice(-4)}`, currency: 'BDT', rate: D(1), lines: [{ costHeadId: H.trucking, costHeadName: 'Trucking', unitId: uTrip, unitName: 'Trip', quantity: D(1), unitPrice: D(4500) }] },
          ],
        });
        const recv = dateIn(m, 22);
        const half = m === 1 && firstAir;
        firstAir = false;
        if (m >= 1 && recv !== null) await receive({ date: recv, inv, customer: spec.customer, serviceKey: 'INCOME.SERVICE.AIR', share: half ? 0.5 : 1, bankRate: usdRate.minus('0.30') });
        const p1 = dateIn(m, 15);
        if (m >= 1 && p1 !== null) await pay({ date: p1, cost: inv.costs[0]!, invCode: inv.code, serviceKey: 'EXPENSE.COST_OF_SERVICE.AIR', bankRate: usdRate.plus('0.10'), who: 'Emirates SkyCargo' });
        const p2 = dateIn(m, 10);
        if (m >= 1 && p2 !== null) await pay({ date: p2, cost: inv.costs[1]!, invCode: inv.code, serviceKey: 'EXPENSE.COST_OF_SERVICE.AIR', bankRate: D(1), who: 'Karnaphuli CFS & Transport' });
      }
    }

    // Running the office.
    const at = (day: number) => dateIn(m, day);
    const run = async (day: number, fn: (d: Date) => Promise<unknown>) => {
      const d = at(day);
      if (d !== null) await fn(d);
    };
    await run(1, (d) => expense(d, `Office rent — ${month}`, BANK, [['EXPENSE.OPERATING.RENT', 55_000]]));
    await run(2, (d) =>
      voucher({ kind: 'TRANSFER', date: d, description: `Petty cash top-up — ${month}`, lines: [{ account: CASH, debit: D(30_000) }, { account: BANK, credit: D(30_000) }] }),
    );
    await run(5, (d) => expense(d, `ERP and e-mail subscriptions — ${month}`, BANK, [['EXPENSE.OPERATING.COMPUTER_SOFTWARE', 8_000]]));
    await run(8, (d) => expense(d, 'Office stationery', CASH, [['EXPENSE.OPERATING.STATIONERY', 3_000]]));
    await run(10, (d) => expense(d, `Electricity and water — ${month}`, BANK, [['EXPENSE.OPERATING.UTILITIES', 12_000]]));
    await run(12, (d) =>
      expense(d, `Internet and mobile bills — ${month}`, BANK, [
        ['EXPENSE.OPERATING.INTERNET', 4_500],
        ['EXPENSE.OPERATING.MOBILE', 5_500],
      ]),
    );
    await run(15, (d) => expense(d, 'Vehicle fuel', CASH, [['EXPENSE.OPERATING.VEHICLE_FUEL', 12_000]]));
    await run(20, (d) => expense(d, 'Client meals and entertainment', CASH, [['EXPENSE.OPERATING.MEAL', 5_000]]));
    await run(21, (d) => expense(d, 'TA-DA for port and customs visits', CASH, [['EXPENSE.OPERATING.TA_DA', 4_000]]));
    await run(28, (d) =>
      expense(d, `Salaries — ${month}`, BANK, [
        ['EXPENSE.PAYROLL.SALARY', 220_000],
        ['EXPENSE.PAYROLL.BENEFITS', 18_000],
      ]),
    );
    await run(28, (d) => expense(d, `Sales incentive — ${month}`, BANK, [['EXPENSE.OPERATING.SALES_INCENTIVE', 15_000]]));
    await run(28, (d) => expense(d, 'Bank service charges', BANK, [['EXPENSE.OPERATING.BANK_CHARGE', 1_150]]));
    await run(28, (d) =>
      voucher({
        kind: 'JOURNAL',
        date: d,
        description: `Depreciation — ${month}`,
        lines: [
          { account: acct('EXPENSE.OPERATING.DEPRECIATION'), debit: D(10_000) },
          { account: acct('ASSET.OTHER_LONG_TERM.BUILDING'), credit: D(10_000) },
        ],
      }),
    );
    if (m % 3 === 0) await run(16, (d) => expense(d, 'Facebook and LinkedIn campaign', BANK, [['EXPENSE.OPERATING.ADVERTISEMENT', 10_000]]));
    if (m % 6 === 0) await run(5, (d) => expense(d, 'Office and cargo-liability insurance (half-yearly)', BANK, [['EXPENSE.OPERATING.INSURANCE', 20_000]]));
    if (m % 3 === 1) {
      await run(30, (d) =>
        voucher({
          kind: 'INCOME',
          date: d,
          description: 'Fixed deposit interest (quarterly)',
          lines: [{ account: BANK, debit: D(12_500) }, { account: acct('INCOME.OTHER.FIXED_DEPOSIT'), credit: D(12_500) }],
        }),
      );
      await run(30, (d) =>
        voucher({
          kind: 'JOURNAL',
          date: d,
          description: 'Income tax provision (quarterly)',
          lines: [
            { account: acct('EXPENSE.TAX.INCOME_TAX'), debit: D(45_000) },
            { account: acct('LIABILITY.OTHER_SHORT_TERM'), credit: D(45_000) },
          ],
        }),
      );
    }
    if (m === 2) {
      await run(26, (d) =>
        voucher({
          kind: 'JOURNAL',
          date: d,
          description: 'Volume discount allowed to Meghna Knitwear',
          lines: [
            { account: acct('EXPENSE.DISCOUNT'), debit: D(8_000) },
            { account: acct('ASSET.RECEIVABLE.SEA_FCL'), credit: D(8_000) },
          ],
        }),
      );
    }
  }

  // ------------------------------------------- this month, still to do by hand
  const today = dateIn(0, now.getUTCDate())!;
  const awaitingLines: Line[] = [
    { costHeadId: H.oceanFreight, costHeadName: 'Ocean Freight', unitId: uContainer, unitName: 'Container', containerSizeId: size20, containerSizeName: '20STD', quantity: D(1), unitPrice: D(1500) },
    { costHeadId: H.blFee, costHeadName: 'B/L Fee', unitId: uHbl, unitName: 'HBL', quantity: D(1), unitPrice: D(50) },
  ];
  const awaiting = await booking({ date: today, customer: meghna, goods: knit, type: 'SEA', loading: 'FCL', carrierId: cmaCgm, pol: ctg, pod: ham, currency: 'USD', rate: D('121.20'), lines: awaitingLines, cargo: [container(knit, 0)] });
  const draftLines: Line[] = [{ costHeadId: H.lclFreight, costHeadName: 'LCL Freight', unitId: uCbm, unitName: 'CBM', quantity: D(6), unitPrice: D(4500) }];
  const draftJob = await booking({ date: today, customer: padma, goods: handbags, type: 'SEA', loading: 'LCL', carrierId: cmaCgm, pol: ctg, pod: ham, currency: 'BDT', rate: D(1), lines: draftLines, cargo: [lcl(handbags, 6)] });
  const draft = await invoice({ date: today, job: draftJob, customer: padma, currency: 'BDT', rate: D(1), lines: draftLines, costs: [], status: 'DRAFT' });

  return [
    `  bank       : Bank Asia Ltd, Agrabad — account 0863303387801 (and Cash on Hand)`,
    `  customers  : Meghna Knitwear and Jamuna Denim (FCL, LCL), Padma Leather (LCL), Rupsha Pharma (Air)`,
    `  jobs       : ${counters['invoice']} debit invoices over ${MONTHS} months, each with carrier / agent / vendor costs`,
    `  bookings   : ${counters['job']}, each taken through schedule, S/O, receipt, load plan, advise and BL issue — sea reads`,
    `               BL issued, air (no BL) Shipment advised; all sailed, arrived once due, sea pre-alerted before this month`,
    `  vouchers   : ${(counters['INCOME'] ?? 0)} income, ${(counters['EXPENSE'] ?? 0)} expense, ${(counters['TRANSFER'] ?? 0)} transfer, ${(counters['JOURNAL'] ?? 0)} journal`,
    `  to try     : ${awaiting.code} waits on Awaiting Freight Inv; ${draft.code} is a draft on Debit Invoice`,
    `  outstanding: this month's invoices are not yet received or paid; one Air invoice is half paid`,
  ];
}
