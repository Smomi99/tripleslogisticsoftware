/* eslint-disable no-console */
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from '@node-rs/argon2';

import { PrismaClient } from '../apps/api/src/generated/prisma/client';

/**
 * Demo data — a workspace with enough in it to try the product on.
 *
 * Separate from seed.ts on purpose. That script runs against production
 * (`pnpm db:seed`) and seeds permissions, lookups and shared masters; inventing
 * customers and shipments there would put fiction in front of a real
 * forwarder. This one only ever writes rows whose business code starts with
 * DEMO-, and `--clear` deletes exactly those, so it cannot damage anything a
 * person typed in.
 *
 *   pnpm db:demo          seed it (clears and rebuilds, so it is repeatable)
 *   pnpm db:demo:clear    take it all out again
 *
 * The dataset is built backwards from what there is to look at:
 *
 *   - four salespeople on different incentive rates, so the Performance Report
 *     shows different numbers per person and per period;
 *   - work dated across this month, last month and six months back, so the
 *     period filter visibly changes the answer rather than being a control
 *     that does nothing;
 *   - two customers with no salesman, so the red "Unassigned" marking has
 *     something to mark;
 *   - inquiries in all four shapes — FCL, LCL, Consol Box and Air;
 *   - rates carrying a Route, priced with local charges;
 *   - bookings parked in six different states, so Shipment Approval, Shipping
 *     Order and Cargo Receipt each open with rows waiting rather than empty.
 */

const connectionString = process.env['DATABASE_URL'];
if (connectionString === undefined || connectionString === '') {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/** Every row this script writes carries it, and clearing keys off it. */
const P = 'DEMO-';

const SLUG = process.env['DEMO_TENANT_SLUG'] ?? 'demo';

// --------------------------------------------------------------------- dates

const now = new Date();
const utc = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m, d, 9, 0, 0));

/** N days before today, at 09:00 UTC — inside whichever period that lands in. */
function daysAgo(n: number): Date {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(9, 0, 0, 0);
  return d;
}

/** N months back, same day of month. */
function monthsAgo(n: number): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - n);
  d.setUTCHours(9, 0, 0, 0);
  return d;
}

const day = (d: Date): Date => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);

// -------------------------------------------------------------------- clear

/**
 * Remove everything this script made, children first.
 *
 * Hard deletes rather than soft: these rows are scenery, and leaving
 * deleted_at stamps behind would mean the next run collided with codes nobody
 * can see. Restricted to DEMO- codes throughout, and to rows that hang off a
 * DEMO- parent where the child has no code of its own.
 */
async function clear(tenantId: bigint): Promise<void> {
  const t = { tenantId };
  const demoCode = { code: { startsWith: P } };

  const shipmentIds = (
    await prisma.shipment.findMany({ where: { ...t, ...demoCode }, select: { id: true } })
  ).map((r) => r.id);
  const scheduleIds = (
    await prisma.shipmentSchedule.findMany({
      where: { ...t, shipmentId: { in: shipmentIds } },
      select: { id: true },
    })
  ).map((r) => r.id);
  const quotationIds = (
    await prisma.quotation.findMany({ where: { ...t, ...demoCode }, select: { id: true } })
  ).map((r) => r.id);
  const inquiryIds = (
    await prisma.inquiry.findMany({ where: { ...t, ...demoCode }, select: { id: true } })
  ).map((r) => r.id);
  const rateIds = (
    await prisma.freightRate.findMany({ where: { ...t, ...demoCode }, select: { id: true } })
  ).map((r) => r.id);
  const employeeIds = (
    await prisma.employee.findMany({ where: { ...t, ...demoCode }, select: { id: true } })
  ).map((r) => r.id);

  await prisma.cargoReceiptLine.deleteMany({
    where: { ...t, receipt: { shipmentId: { in: shipmentIds } } },
  });
  await prisma.cargoReceipt.deleteMany({ where: { ...t, shipmentId: { in: shipmentIds } } });
  await prisma.shippingOrder.deleteMany({ where: { ...t, shipmentId: { in: shipmentIds } } });
  await prisma.shipmentScheduleLeg.deleteMany({ where: { ...t, scheduleId: { in: scheduleIds } } });
  await prisma.shipmentSchedule.deleteMany({ where: { ...t, shipmentId: { in: shipmentIds } } });
  await prisma.shipmentCargoLine.deleteMany({ where: { ...t, shipmentId: { in: shipmentIds } } });
  await prisma.shipmentCommodity.deleteMany({ where: { ...t, shipmentId: { in: shipmentIds } } });
  await prisma.shipmentPo.deleteMany({ where: { ...t, shipmentId: { in: shipmentIds } } });
  await prisma.shipment.deleteMany({ where: { ...t, id: { in: shipmentIds } } });

  await prisma.quotationFollowup.deleteMany({ where: { ...t, quotationId: { in: quotationIds } } });
  await prisma.quotationRecipient.deleteMany({ where: { ...t, quotationId: { in: quotationIds } } });
  await prisma.quotationCommodity.deleteMany({ where: { ...t, quotationId: { in: quotationIds } } });
  await prisma.quotationLine.deleteMany({ where: { ...t, quotationId: { in: quotationIds } } });
  await prisma.quotation.deleteMany({ where: { ...t, id: { in: quotationIds } } });

  /*
   * Anything of the user's OWN hanging off demo data stops the clear.
   *
   * Raising a quotation on a demo inquiry, or an inquiry for a demo customer,
   * is the obvious way to try the product — and it leaves real work pointing
   * at scenery. Deleting it to tidy up would destroy something somebody did;
   * crashing with a foreign-key stack trace explains nothing. So: stop before
   * touching anything, name exactly what is in the way, and let them decide.
   */
  const [heldQuotations, heldInquiries] = await Promise.all([
    prisma.quotation.findMany({
      where: {
        ...t,
        deletedAt: null,
        code: { not: { startsWith: P } },
        inquiry: { code: { startsWith: P } },
      },
      select: { code: true, inquiry: { select: { code: true } } },
    }),
    prisma.inquiry.findMany({
      where: {
        ...t,
        deletedAt: null,
        code: { not: { startsWith: P } },
        customer: { code: { startsWith: P } },
      },
      select: { code: true, customer: { select: { code: true } } },
    }),
  ]);

  const blocking = [
    ...heldQuotations.map((q) => `  ${q.code} — quotation on ${q.inquiry.code}`),
    ...heldInquiries.map((i) => `  ${i.code} — inquiry for ${i.customer?.code ?? "a demo customer"}`),
  ];
  if (blocking.length > 0) {
    throw new Error(
      'Cannot remove the demo data — this work of yours is built on it:' +
        `\n${blocking.join('\n')}\n\n` +
        'Delete those records first, or leave the demo data in place. Nothing has been changed.',
    );
  }

  await prisma.agentQuoteLine.deleteMany({
    where: { ...t, option: { quote: { inquiryId: { in: inquiryIds } } } },
  });
  await prisma.agentQuoteComment.deleteMany({
    where: { ...t, quote: { inquiryId: { in: inquiryIds } } },
  });
  await prisma.agentQuoteOption.deleteMany({
    where: { ...t, quote: { inquiryId: { in: inquiryIds } } },
  });
  await prisma.agentQuote.deleteMany({ where: { ...t, inquiryId: { in: inquiryIds } } });
  await prisma.inquiryRate.deleteMany({ where: { ...t, inquiryId: { in: inquiryIds } } });
  await prisma.inquiryFollowup.deleteMany({ where: { ...t, inquiryId: { in: inquiryIds } } });
  await prisma.inquiryPartyContact.deleteMany({ where: { ...t, inquiryId: { in: inquiryIds } } });
  await prisma.inquiryVolume.deleteMany({ where: { ...t, inquiryId: { in: inquiryIds } } });
  await prisma.inquiryCommodity.deleteMany({ where: { ...t, inquiryId: { in: inquiryIds } } });
  await prisma.inquiryParty.deleteMany({ where: { ...t, inquiryId: { in: inquiryIds } } });
  await prisma.inquiry.deleteMany({ where: { ...t, id: { in: inquiryIds } } });

  await prisma.rateLocalCharge.deleteMany({ where: { ...t, rateId: { in: rateIds } } });
  await prisma.freightRateLine.deleteMany({ where: { ...t, rateId: { in: rateIds } } });
  await prisma.freightRate.deleteMany({ where: { ...t, id: { in: rateIds } } });

  await prisma.salesLeadFollowup.deleteMany({
    where: { ...t, lead: { code: { startsWith: P } } },
  });
  await prisma.salesLead.deleteMany({ where: { ...t, ...demoCode } });

  await prisma.emailLog.deleteMany({ where: { ...t, templateKey: { startsWith: P } } });
  await prisma.customerPic.deleteMany({ where: { ...t, customer: { code: { startsWith: P } } } });
  await prisma.customer.deleteMany({ where: { ...t, ...demoCode } });
  await prisma.commodityItem.deleteMany({
    where: { ...t, industrySector: { code: { startsWith: P } } },
  });
  await prisma.industrySector.deleteMany({ where: { ...t, ...demoCode } });
  await prisma.costHead.deleteMany({ where: { ...t, ...demoCode } });

  await prisma.user.deleteMany({ where: { ...t, employeeId: { in: employeeIds } } });
  await prisma.employee.deleteMany({ where: { ...t, id: { in: employeeIds } } });

  // The agent login, its role, and the agent it belongs to.
  await prisma.user.deleteMany({ where: { ...t, ...demoCode } });
  await prisma.rolePermission.deleteMany({
    where: { ...t, role: { code: { startsWith: P } } },
  });
  await prisma.role.deleteMany({ where: { ...t, ...demoCode } });
  await prisma.agentPic.deleteMany({ where: { ...t, agent: { code: { startsWith: P } } } });
  await prisma.agentExpertArea.deleteMany({
    where: { ...t, agent: { code: { startsWith: P } } },
  });
  await prisma.agentPortCoverage.deleteMany({
    where: { ...t, agent: { code: { startsWith: P } } },
  });
  await prisma.agentNetworkMember.deleteMany({
    where: { ...t, agent: { code: { startsWith: P } } },
  });
  await prisma.agent.deleteMany({ where: { ...t, ...demoCode } });

  // The audit trail for rows that no longer exist is noise, not history.
  await prisma.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE tenant_id = ${tenantId} AND new_values->>'code' LIKE '${P}%'`,
  );
}

// --------------------------------------------------------------------- seed

async function seed(tenantId: bigint): Promise<void> {
  const t = { tenantId };
  const password = await hash('ChangeMe!2026');

  // ------------------------------------------------- masters this data needs
  const sectors = await Promise.all(
    [
      ['IS1', 'Garments & Textiles'],
      ['IS2', 'Leather Goods'],
      ['IS3', 'Pharmaceuticals'],
      ['IS4', 'Agro & Frozen Food'],
    ].map(([suffix, name], i) =>
      prisma.industrySector.create({
        data: { ...t, code: `${P}${suffix}`, name: name!, createdAt: monthsAgo(10 - i) },
        select: { id: true, name: true },
      }),
    ),
  );

  await Promise.all([
    prisma.commodityItem.create({
      data: {
        ...t,
        code: `${P}CI1`,
        industrySectorId: sectors[0]!.id,
        name: 'Knitted T-Shirts',
        hsCode: '6109.10',
      },
    }),
    prisma.commodityItem.create({
      data: {
        ...t,
        code: `${P}CI2`,
        industrySectorId: sectors[0]!.id,
        name: 'Denim Trousers',
        hsCode: '6203.42',
      },
    }),
    prisma.commodityItem.create({
      data: {
        ...t,
        code: `${P}CI3`,
        industrySectorId: sectors[1]!.id,
        name: 'Leather Footwear',
        hsCode: '6403.99',
      },
    }),
    prisma.commodityItem.create({
      data: {
        ...t,
        code: `${P}CI4`,
        industrySectorId: sectors[2]!.id,
        name: 'Generic Tablets',
        hsCode: '3004.90',
      },
    }),
    prisma.commodityItem.create({
      data: {
        ...t,
        code: `${P}CI5`,
        industrySectorId: sectors[3]!.id,
        name: 'Frozen Shrimp',
        hsCode: '0306.17',
      },
    }),
  ]);

  const unit = await prisma.costUnit.findFirstOrThrow({ select: { id: true } });
  const costHeads = await Promise.all(
    [
      ['CH1', 'Ocean Freight'],
      ['CH2', 'Air Freight'],
      ['CH3', 'Terminal Handling'],
      ['CH4', 'Documentation'],
    ].map(([suffix, name]) =>
      prisma.costHead.create({
        data: {
          ...t,
          code: `${P}${suffix}`,
          name: name!,
          category: 'SERVICE',
          unitId: unit.id,
        },
        select: { id: true, name: true },
      }),
    ),
  );

  // ------------------------------------------------------- shared references
  const port = (portCode: string) =>
    prisma.port.findFirstOrThrow({
      where: { portCode, OR: [{ tenantId }, { tenantId: null }] },
      select: { id: true, name: true },
    });
  const [cgp, ham, sin, jfk, dxb] = await Promise.all([
    port('BDCGP'),
    port('DEHAM'),
    port('SGSIN'),
    port('USJFK').catch(() => port('DEHAM')),
    port('AEDXB').catch(() => port('SGSIN')),
  ]);

  const carriers = await prisma.carrier.findMany({
    where: { OR: [{ tenantId }, { tenantId: null }], deletedAt: null },
    take: 4,
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  const currency = await prisma.currency.findFirstOrThrow({
    where: { currency: { startsWith: 'BDT' } },
    select: { id: true, conversion: true },
  });
  // Shared masters (tenant_id NULL), like ports and carriers — a workspace
  // uses them without owning them (§7A rule 7).
  const shared = { OR: [{ tenantId }, { tenantId: null }], deletedAt: null };
  const goodsTypes = await prisma.goodsType.findMany({
    where: shared,
    select: { id: true, name: true },
  });
  const sources = await prisma.inquirySource.findMany({
    where: shared,
    take: 3,
    select: { id: true },
  });
  const sizes = await prisma.containerSize.findMany({
    where: { OR: [{ tenantId }, { tenantId: null }], deletedAt: null },
    orderBy: { code: 'asc' },
    select: { id: true, code: true },
  });
  const vessels = await prisma.vessel.findMany({ where: { ...t }, take: 2, select: { id: true } });

  // ------------------------------------------------------------- employees
  const staff = [
    { s: 'EMP-1', name: 'Nasir Ahmed', dept: 'Sales', desig: 'Senior Sales Executive', pct: '7.50', user: 'nasir' },
    { s: 'EMP-2', name: 'Farhana Islam', dept: 'Sales', desig: 'Sales Executive', pct: '5.00', user: 'farhana' },
    { s: 'EMP-3', name: 'Rakib Hasan', dept: 'Customer Service', desig: 'CS Officer', pct: null, user: 'rakib' },
    { s: 'EMP-4', name: 'Tanvir Chowdhury', dept: 'Sales', desig: 'Sales Manager', pct: '10.00', user: 'tanvir' },
  ];

  const employees: { id: bigint; userId: bigint; name: string }[] = [];
  for (const [i, person] of staff.entries()) {
    const employee = await prisma.employee.create({
      data: {
        ...t,
        code: `${P}${person.s}`,
        name: person.name,
        country: 'Bangladesh',
        department: person.dept,
        designation: person.desig,
        joiningDate: day(monthsAgo(18 + i * 6)),
        officeMobile: `+8801711${String(100000 + i * 1111).slice(0, 6)}`,
        personalEmail: `${person.user}@demofreight.test`,
        incentivePercentage: person.pct,
        createdAt: monthsAgo(18 + i * 6),
      },
      select: { id: true },
    });
    const user = await prisma.user.create({
      data: {
        ...t,
        code: `${P}USR-${i + 1}`,
        username: `${P.toLowerCase()}${person.user}`,
        email: `${person.user}@demofreight.test`,
        passwordHash: password,
        employeeId: employee.id,
        isSuperadmin: false,
      },
      select: { id: true },
    });
    employees.push({ id: employee.id, userId: user.id, name: person.name });
  }

  // ------------------------------------------------------ an agent to log in as
  //
  // An agent signs in at the same /login as staff; what makes the session an
  // agent's is the agent_id on the user row, and every staff router refuses a
  // session that has one. They also need a role granting AGENT.INQUIRY, or
  // they sign in successfully and see an empty product.
  const agent = await prisma.agent.create({
    data: {
      ...t,
      code: `${P}AGT-1`,
      name: 'Gulf Freight Partners LLC',
      country: 'United Arab Emirates',
      address: 'Jebel Ali Free Zone, Dubai',
      agentType: 'GENERAL',
      createdAt: monthsAgo(8),
    },
    select: { id: true },
  });
  await prisma.agentPic.create({
    data: {
      ...t,
      code: `${P}APIC-1`,
      agentId: agent.id,
      name: 'Yousef Rahman',
      designation: 'Operations Manager',
      email: 'yousef@gulffreight.test',
      mobile: '+971501234567',
    },
  });

  const agentRole = await prisma.role.create({
    data: {
      ...t,
      code: `${P}ROL-1`,
      name: 'Agent (demo)',
      description: 'What an overseas agent can reach: their own inquiries, and quoting on them.',
    },
    select: { id: true },
  });
  const agentPermissions = await prisma.permission.findMany({
    where: { module: 'AGENT' },
    select: { id: true },
  });
  for (const permission of agentPermissions) {
    await prisma.rolePermission.create({
      data: { ...t, roleId: agentRole.id, permissionId: permission.id },
    });
  }
  await prisma.user.create({
    data: {
      ...t,
      code: `${P}USR-AGT`,
      username: `${P.toLowerCase()}agent`,
      email: 'yousef@gulffreight.test',
      passwordHash: password,
      agentId: agent.id,
      roleId: agentRole.id,
      isSuperadmin: false,
    },
  });

  // -------------------------------------------------------------- customers
  //
  // Six owned, two deliberately unowned — the red "Unassigned" marking needs
  // something to mark, and an empty state proves nothing.
  const customerPlan = [
    { s: 'CUS-1', name: 'Dhaka Apparels Ltd', sector: 0, owner: 0, ago: 4 },
    { s: 'CUS-2', name: 'Chittagong Knitwear', sector: 0, owner: 0, ago: 20 },
    { s: 'CUS-3', name: 'Bengal Leather Works', sector: 1, owner: 1, ago: 9 },
    { s: 'CUS-4', name: 'Padma Pharmaceuticals', sector: 2, owner: 1, ago: 45 },
    { s: 'CUS-5', name: 'Sundarban Foods', sector: 3, owner: 3, ago: 12 },
    { s: 'CUS-6', name: 'Jamuna Textiles', sector: 0, owner: 3, ago: 100 },
    { s: 'CUS-7', name: 'Meghna Traders', sector: 1, owner: null, ago: 6 },
    { s: 'CUS-8', name: 'Karnaphuli Exports', sector: 3, owner: null, ago: 30 },
  ];

  const customers: { id: bigint; name: string }[] = [];
  for (const c of customerPlan) {
    const created = await prisma.customer.create({
      data: {
        ...t,
        code: `${P}${c.s}`,
        name: c.name,
        country: 'Bangladesh',
        address: 'Motijheel C/A, Dhaka 1000',
        customerType: 'EXPORTER',
        businessArea: 'OUTBOUND',
        industrySectorId: sectors[c.sector]!.id,
        salesmanId: c.owner === null ? null : employees[c.owner]!.id,
        createdAt: daysAgo(c.ago),
      },
      select: { id: true, name: true },
    });
    await prisma.customerPic.create({
      data: {
        ...t,
        code: `${P}PIC-${customers.length + 1}`,
        customerId: created.id,
        name: `${c.name.split(' ')[0]} Desk`,
        designation: 'Export Manager',
        email: `export@${c.s.toLowerCase()}.test`,
        mobile: '+8801811223344',
      },
    });
    customers.push(created);
  }

  // ------------------------------------------------------------ sales leads
  const leadPlan = [
    ['LED-1', 'Rangpur Ceramics', 0, 3],
    ['LED-2', 'Sylhet Tea Exporters', 0, 11],
    ['LED-3', 'Barisal Jute Mills', 1, 25],
    ['LED-4', 'Comilla Cold Storage', 3, 40],
    ['LED-5', 'Khulna Seafood', 3, 70],
    ['LED-6', 'Bogra Agro', 1, 150],
  ] as const;
  for (const [suffix, name, owner, ago] of leadPlan) {
    await prisma.salesLead.create({
      data: {
        ...t,
        code: `${P}${suffix}`,
        name,
        notes: 'Introduced at a trade fair. Wants indicative rates before committing.',
        createdBy: employees[owner]!.userId,
        createdAt: daysAgo(ago),
      },
    });
  }

  // ----------------------------------------------------------------- rates
  //
  // Each carries a Route, the field added on 2026-09-06, so the column has
  // something in it on both the entry screen and the price list.
  const ratePlan = [
    { s: 'RATE-1', mode: 'SEA_FCL' as const, pol: cgp, pod: ham, route: 'Direct', transit: 24 },
    { s: 'RATE-2', mode: 'SEA_FCL' as const, pol: cgp, pod: sin, route: 'via Colombo', transit: 12 },
    { s: 'RATE-3', mode: 'SEA_LCL' as const, pol: cgp, pod: ham, route: 'via Singapore', transit: 32 },
    { s: 'RATE-4', mode: 'AIR' as const, pol: cgp, pod: dxb, route: 'Direct', transit: 1 },
  ];

  for (const [i, r] of ratePlan.entries()) {
    const carrier = carriers[i % carriers.length]!;
    const rate = await prisma.freightRate.create({
      data: {
        ...t,
        code: `${P}${r.s}`,
        mode: r.mode,
        polId: r.pol.id,
        podId: r.pod.id,
        carrierId: carrier.id,
        goodsTypeId: goodsTypes[0]!.id,
        currencyId: currency.id,
        validFrom: day(daysAgo(30)),
        validTo: day(daysAgo(-120)),
        route: r.route,
        transitDays: r.transit,
        freeDays: 14,
        status: 'PUBLISHED',
        purchaseSourceType: 'CARRIER',
        purchaseCarrierId: carrier.id,
        createdAt: daysAgo(30),
      },
      select: { id: true },
    });

    const tiers = await prisma.rateTier.findMany({
      where: { mode: r.mode },
      select: { id: true },
    });
    for (const [j, tier] of tiers.entries()) {
      await prisma.freightRateLine.create({
        data: {
          ...t,
          rateId: rate.id,
          tierId: tier.id,
          buyPrice: String(800 + j * 450),
          profitType: 'FLAT',
          profitValue: String(120 + j * 30),
        },
      });
    }

    await prisma.rateLocalCharge.create({
      data: {
        ...t,
        rateId: rate.id,
        costHeadId: costHeads[2]!.id,
        side: 'POL',
        amount: '65.0000',
        currencyId: currency.id,
      },
    });
    await prisma.rateLocalCharge.create({
      data: {
        ...t,
        rateId: rate.id,
        costHeadId: costHeads[3]!.id,
        side: 'POD',
        amount: '40.0000',
        currencyId: currency.id,
      },
    });
  }

  // ------------------------------------------------------------- inquiries
  //
  // Spread over this month, last month and half a year back, so the
  // Performance Report's period filter visibly changes the answer. All four
  // shapes appear, including the Consol Box added on 2026-09-06.
  const inquiryPlan = [
    { s: 'INQ-1', cust: 0, sales: 0, ago: 2, type: 'SEA' as const, load: 'FCL' as const, status: 'OPEN' as const },
    { s: 'INQ-2', cust: 0, sales: 0, ago: 5, type: 'SEA' as const, load: 'LCL' as const, status: 'QUOTED' as const },
    { s: 'INQ-3', cust: 1, sales: 0, ago: 9, type: 'SEA' as const, load: 'CONSOL_BOX' as const, status: 'OPEN' as const },
    { s: 'INQ-4', cust: 2, sales: 1, ago: 13, type: 'AIR' as const, load: null, status: 'QUOTED' as const },
    { s: 'INQ-5', cust: 3, sales: 1, ago: 21, type: 'SEA' as const, load: 'FCL' as const, status: 'WON' as const },
    { s: 'INQ-6', cust: 4, sales: 3, ago: 34, type: 'SEA' as const, load: 'FCL' as const, status: 'QUOTED' as const },
    { s: 'INQ-7', cust: 5, sales: 3, ago: 48, type: 'AIR' as const, load: null, status: 'LOST' as const },
    { s: 'INQ-8', cust: 0, sales: 0, ago: 66, type: 'SEA' as const, load: 'LCL' as const, status: 'OPEN' as const },
    { s: 'INQ-9', cust: 2, sales: 1, ago: 95, type: 'SEA' as const, load: 'FCL' as const, status: 'WON' as const },
    { s: 'INQ-10', cust: 4, sales: 3, ago: 140, type: 'SEA' as const, load: 'CONSOL_BOX' as const, status: 'OPEN' as const },
  ];

  const inquiries: { id: bigint; cust: number; sales: number; type: 'SEA' | 'AIR' }[] = [];
  for (const [i, q] of inquiryPlan.entries()) {
    const when = daysAgo(q.ago);
    const isAir = q.type === 'AIR';
    const created = await prisma.inquiry.create({
      data: {
        ...t,
        code: `${P}${q.s}`,
        seriesYear: when.getUTCFullYear(),
        inquiryDate: day(when),
        sourceId: sources[i % sources.length]!.id,
        shipmentType: q.type,
        customerId: customers[q.cust]!.id,
        movementType: 'OUTBOUND',
        loadingType: q.load,
        polId: cgp.id,
        podId: isAir ? dxb.id : ham.id,
        goodsTypeId: goodsTypes[i % goodsTypes.length]!.id,
        salesmanId: employees[q.sales]!.id,
        status: q.status,
        weightKg: String(2000 + i * 350),
        targetPrice: String(1500 + i * 120),
        validTo: day(daysAgo(q.ago - 30)),
        remarks: 'Demo data — safe to delete with pnpm db:demo:clear.',
        createdAt: when,
      },
      select: { id: true },
    });

    // The volume grid, in the shape the loading type calls for.
    if (q.load === 'FCL') {
      await prisma.inquiryVolume.create({
        data: { ...t, inquiryId: created.id, volumeKind: 'FCL', containerSizeId: sizes[0]!.id, quantity: 2 },
      });
      await prisma.inquiryVolume.create({
        data: { ...t, inquiryId: created.id, volumeKind: 'FCL', containerSizeId: sizes[1]!.id, quantity: 1 },
      });
    } else if (isAir) {
      await prisma.inquiryVolume.create({
        data: { ...t, inquiryId: created.id, volumeKind: 'AIR', weightKg: String(850 + i * 40) },
      });
    } else {
      await prisma.inquiryVolume.create({
        data: { ...t, inquiryId: created.id, volumeKind: 'LCL', cbm: String(18 + i) },
      });
    }

    inquiries.push({ id: created.id, cust: q.cust, sales: q.sales, type: q.type });
  }

  // ------------------------------------------------------------ quotations
  const quotationPlan = [
    { s: 'QTN-1', inq: 1, status: 'SENT' as const },
    { s: 'QTN-2', inq: 3, status: 'SENT' as const },
    { s: 'QTN-3', inq: 4, status: 'ACCEPTED' as const },
    { s: 'QTN-4', inq: 5, status: 'DRAFT' as const },
    { s: 'QTN-5', inq: 8, status: 'ACCEPTED' as const },
  ];

  const quotations: { id: bigint; inq: number }[] = [];
  for (const [i, q] of quotationPlan.entries()) {
    const source = inquiries[q.inq]!;
    const isAir = source.type === 'AIR';
    const when = daysAgo(inquiryPlan[q.inq]!.ago - 1);
    const created = await prisma.quotation.create({
      data: {
        ...t,
        code: `${P}${q.s}`,
        seriesYear: when.getUTCFullYear(),
        inquiryId: source.id,
        quotationDate: day(when),
        validityDate: day(daysAgo(-30)),
        customerId: customers[source.cust]!.id,
        shipmentType: source.type,
        movementType: 'OUTBOUND',
        loadingType: inquiryPlan[q.inq]!.load,
        polId: cgp.id,
        podId: isAir ? dxb.id : ham.id,
        carrierId: carriers[i % carriers.length]!.id,
        localCurrencyId: currency.id,
        conversionRate: currency.conversion,
        status: q.status,
        sentAt: q.status === 'DRAFT' ? null : when,
        createdAt: when,
      },
      select: { id: true },
    });

    for (const [j, head] of [costHeads[0]!, costHeads[2]!, costHeads[3]!].entries()) {
      await prisma.quotationLine.create({
        data: {
          ...t,
          quotationId: created.id,
          lineGroup: j === 0 ? 'STANDARD' : 'ADDITIONAL',
          sortOrder: j + 1,
          costHeadId: head.id,
          costHeadName: head.name,
          quantity: j === 0 ? '2' : '1',
          sellingPrice: j === 0 ? '1450.0000' : String(60 + j * 25),
          currencyId: currency.id,
          currencyCode: 'BDT',
          conversionRate: currency.conversion,
          /*
            MANUAL, all of them. quotation_line_auto_has_source_ck refuses an
            AUTO line that cannot name the rate line or local charge it was
            pulled from, and these were built by hand — which is precisely
            what MANUAL means. §6.5 marks them in --signal on the screen.
          */
          source: 'MANUAL',
        },
      });
    }
    quotations.push({ id: created.id, inq: q.inq });
  }

  // -------------------------------------------------------------- bookings
  //
  // One in each state the status machine reaches, so the three worklists open
  // with rows waiting rather than empty.
  const bookingPlan = [
    { s: 'BKG-1', qtn: 0, status: 'BOOKING_RECEIVED' as const, schedule: false, approved: false, so: false },
    { s: 'BKG-2', qtn: 1, status: 'VESSEL_PROPOSED' as const, schedule: true, approved: false, so: false },
    { s: 'BKG-3', qtn: 2, status: 'APPROVED_FOR_SHIPMENT' as const, schedule: true, approved: true, so: false },
    { s: 'BKG-4', qtn: 4, status: 'SO_ISSUED' as const, schedule: true, approved: true, so: true },
    { s: 'BKG-5', qtn: 2, status: 'PART_RECEIVED' as const, schedule: true, approved: true, so: true },
    { s: 'BKG-6', qtn: 4, status: 'CARGO_RECEIVED' as const, schedule: true, approved: true, so: true },
  ];

  for (const [i, b] of bookingPlan.entries()) {
    const q = quotations[b.qtn]!;
    const source = inquiries[q.inq]!;
    const isAir = source.type === 'AIR';
    const when = daysAgo(4 + i * 6);
    const carrier = carriers[i % carriers.length]!;

    const shipment = await prisma.shipment.create({
      data: {
        ...t,
        code: `${P}${b.s}`,
        seriesYear: when.getUTCFullYear(),
        quotationId: q.id,
        shipmentType: source.type,
        customerId: customers[source.cust]!.id,
        exporterName: customers[source.cust]!.name,
        exporterAddress: 'Plot 42, Export Processing Zone, Chattogram',
        importerName: isAir ? 'Gulf Retail FZE' : 'Hamburg Import GmbH',
        carrierId: carrier.id,
        polId: cgp.id,
        podId: isAir ? dxb.id : ham.id,
        loadingType: inquiryPlan[q.inq]!.load,
        transitType: 'DIRECT',
        goodsHandoverDate: day(daysAgo(4 + i * 6 - 2)),
        status: b.status,
        createdAt: when,
      },
      select: { id: true },
    });

    // Two POs, so the Approval screen has something to decide per PO.
    for (const n of [1, 2]) {
      const po = await prisma.shipmentPo.create({
        data: {
          ...t,
          shipmentId: shipment.id,
          poNo: `PO-${1000 + i * 10 + n}`,
          approvalStatus: b.approved ? 'APPROVED' : 'PENDING',
          /*
            shipment_po_decision_ck: a decision has to say who made it and
            when. C/S recorded these on the customer's behalf, which is the
            §9 Q6 case, so approvedOnBehalf says so rather than letting the
            record imply the customer clicked it themselves.
          */
          approvedBy: b.approved ? employees[2]!.userId : null,
          approvedAt: b.approved ? when : null,
          approvedOnBehalf: b.approved,
        },
        select: { id: true },
      });
      await prisma.shipmentCargoLine.create({
        data: {
          ...t,
          shipmentId: shipment.id,
          shipmentPoId: po.id,
          itemCode: `ITEM-${n}`,
          sku: `SKU-${i}${n}`,
          ctnQty: 60 + n * 15,
          pcsQty: (60 + n * 15) * 12,
          netWeightKg: String((60 + n * 15) * 9),
          grossWeightKg: String((60 + n * 15) * 10),
          cartonLengthCm: '60',
          cartonWidthCm: '40',
          cartonHeightCm: '30',
        },
      });
    }

    if (b.schedule) {
      const schedule = await prisma.shipmentSchedule.create({
        data: {
          ...t,
          code: `${P}SCH-${i + 1}`,
          shipmentId: shipment.id,
          carrierId: carrier.id,
          transitType: 'DIRECT',
          cutOffDate: daysAgo(4 + i * 6 - 3),
          // Sea only, per the 2026-09-06 decision.
          vgmDate: isAir ? null : day(daysAgo(4 + i * 6 - 4)),
          siDate: isAir ? null : day(daysAgo(4 + i * 6 - 5)),
          status: b.approved ? 'APPROVED' : 'PROPOSED',
          proposedBy: employees[2]!.userId,
          proposedAt: when,
          // shipment_schedule_decision_ck: anything past PROPOSED has to say
          // who decided it and when.
          decidedBy: b.approved ? employees[2]!.userId : null,
          decidedAt: b.approved ? when : null,
        },
        select: { id: true },
      });
      await prisma.shipmentScheduleLeg.create({
        data: {
          ...t,
          scheduleId: schedule.id,
          legNo: 1,
          vesselId: isAir ? null : (vessels[0]?.id ?? null),
          voyageNo: isAir ? null : `V${230 + i}`,
          flightNo: isAir ? `EK${580 + i}` : null,
          originPortId: cgp.id,
          destinationPortId: isAir ? dxb.id : ham.id,
          etd: daysAgo(4 + i * 6 - 8),
          eta: daysAgo(4 + i * 6 - 28),
        },
      });

      if (b.so) {
        await prisma.shippingOrder.create({
          data: {
            ...t,
            code: `${P}SO-${i + 1}`,
            seriesYear: when.getUTCFullYear(),
            shipmentId: shipment.id,
            scheduleId: schedule.id,
            issueDate: day(daysAgo(4 + i * 6 - 6)),
            // shipping_order_issued_ck: an issued order names who issued it.
            issuedBy: employees[2]!.userId,
            firstVesselName: isAir ? null : 'MV Demo Trader',
            firstFlightNo: isAir ? `EK${580 + i}` : null,
            warehouseCfs: 'Pangaon Inland Container Terminal',
            status: 'ISSUED',
            qrPayload: `SO:${P}SO-${i + 1}\nBKG:${P}${b.s}`,
          },
        });
      }
    }
  }
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const clearOnly = process.argv.includes('--clear');

  const tenant = await prisma.tenant.findFirst({
    where: { slug: SLUG },
    select: { id: true, name: true, slug: true },
  });
  if (tenant === null) {
    throw new Error(
      `No workspace with slug "${SLUG}". Run \`pnpm db:seed\` with SEED_DEV_TENANT=true first, ` +
        'or set DEMO_TENANT_SLUG to the one you mean.',
    );
  }

  console.log(`Workspace: ${tenant.name} (${tenant.slug})`);
  console.log(`Only rows whose code starts with "${P}" are touched.\n`);

  await clear(tenant.id);
  if (clearOnly) {
    console.log('Demo data removed.');
    return;
  }

  await seed(tenant.id);

  const counts = await Promise.all([
    prisma.employee.count({ where: { tenantId: tenant.id, code: { startsWith: P } } }),
    prisma.customer.count({ where: { tenantId: tenant.id, code: { startsWith: P } } }),
    prisma.salesLead.count({ where: { tenantId: tenant.id, code: { startsWith: P } } }),
    prisma.freightRate.count({ where: { tenantId: tenant.id, code: { startsWith: P } } }),
    prisma.inquiry.count({ where: { tenantId: tenant.id, code: { startsWith: P } } }),
    prisma.quotation.count({ where: { tenantId: tenant.id, code: { startsWith: P } } }),
    prisma.shipment.count({ where: { tenantId: tenant.id, code: { startsWith: P } } }),
  ]);

  console.log(`  employees  : ${counts[0]}  (two on incentive, one not)`);
  console.log(`  customers  : ${counts[1]}  (two with no salesman — they read in red)`);
  console.log(`  sales leads: ${counts[2]}`);
  console.log(`  rates      : ${counts[3]}  (each with a Route)`);
  console.log(`  inquiries  : ${counts[4]}  (FCL, LCL, Consol Box and Air, over six months)`);
  console.log(`  quotations : ${counts[5]}`);
  console.log(`  bookings   : ${counts[6]}  (one in each state, so every worklist has rows)`);
  console.log('\nDone. Remove it again with: pnpm db:demo:clear');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
