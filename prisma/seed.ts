// Loads .env from the repo root. Needed when the seed is run directly
// (`pnpm db:seed`) rather than through prisma.config.ts.
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from '@node-rs/argon2';

import { CODE_PREFIX, formatCode, normalizeUsername, PERMISSIONS } from '@ff/shared';

import { PrismaClient } from '../apps/api/src/generated/prisma/client';

/**
 * Database seed (CLAUDE.md §9).
 *
 * Creates the permission registry, the system lookup values from §5–§6, and —
 * for local development — one tenant with a Superadmin user.
 *
 * Runs as the OWNER connection, which bypasses RLS. That is required: the seed
 * writes system rows (tenant_id IS NULL) that no tenant role is permitted to
 * create.
 *
 * Idempotent. Re-running it updates rather than duplicates.
 */

const connectionString = process.env['DATABASE_URL'];
if (connectionString === undefined) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/**
 * Shared master data: the world's ports, currencies and carriers are the same
 * for every forwarder, so these are system rows with tenant_id NULL (§7A rule
 * 7). A workspace may add its own alongside them and switch any of them off for
 * itself, but never edit or delete one.
 *
 * The client will supply their real lists; these are a working starting set so
 * the screens are usable from a fresh clone. Conversion rates in particular are
 * placeholders — a workspace's actual rates live in the tenant-owned
 * currency_rate_history (see the §5 resolution in schema.prisma).
 */
const SYSTEM_PORTS = [
  { name: 'Chattogram', portCode: 'BDCGP', country: 'Bangladesh', type: 'SEAPORT' },
  { name: 'Mongla', portCode: 'BDMGL', country: 'Bangladesh', type: 'SEAPORT' },
  { name: 'Pangaon ICT', portCode: 'BDPAN', country: 'Bangladesh', type: 'SEAPORT' },
  { name: 'Hazrat Shahjalal Intl', portCode: 'DAC', country: 'Bangladesh', type: 'AIRPORT' },
  { name: 'Singapore', portCode: 'SGSIN', country: 'Singapore', type: 'SEAPORT' },
  { name: 'Port Klang', portCode: 'MYPKG', country: 'Malaysia', type: 'SEAPORT' },
  { name: 'Jebel Ali', portCode: 'AEJEA', country: 'United Arab Emirates', type: 'SEAPORT' },
  { name: 'Shanghai', portCode: 'CNSHA', country: 'China', type: 'SEAPORT' },
  { name: 'Ningbo', portCode: 'CNNGB', country: 'China', type: 'SEAPORT' },
  { name: 'Rotterdam', portCode: 'NLRTM', country: 'Netherlands', type: 'SEAPORT' },
  { name: 'Hamburg', portCode: 'DEHAM', country: 'Germany', type: 'SEAPORT' },
  { name: 'New York', portCode: 'USNYC', country: 'United States', type: 'SEAPORT' },
  { name: 'Dubai Intl', portCode: 'DXB', country: 'United Arab Emirates', type: 'AIRPORT' },
  { name: 'Changi', portCode: 'SIN', country: 'Singapore', type: 'AIRPORT' },
] as const;

/** ISO 4217. `conversion` is the system default against BDT (§9 display base). */
const SYSTEM_CURRENCIES = [
  { currency: 'BDT — Bangladeshi Taka', conversion: '1.0000' },
  { currency: 'USD — US Dollar', conversion: '120.0000' },
  { currency: 'EUR — Euro', conversion: '130.0000' },
  { currency: 'GBP — Pound Sterling', conversion: '152.0000' },
  { currency: 'CNY — Chinese Yuan', conversion: '16.5000' },
  { currency: 'SGD — Singapore Dollar', conversion: '89.0000' },
  { currency: 'AED — UAE Dirham', conversion: '32.7000' },
  { currency: 'INR — Indian Rupee', conversion: '1.4000' },
  { currency: 'JPY — Japanese Yen', conversion: '0.7800' },
] as const;

/** Carrier type is matched by name against the carrier_type lookup below. */
const SYSTEM_CARRIERS = [
  { name: 'Maersk Line', type: 'MLO' },
  { name: 'MSC', type: 'MLO' },
  { name: 'CMA CGM', type: 'MLO' },
  { name: 'Hapag-Lloyd', type: 'MLO' },
  { name: 'ONE (Ocean Network Express)', type: 'MLO' },
  { name: 'Evergreen Line', type: 'MLO' },
  { name: 'Emirates SkyCargo', type: 'Airline' },
  { name: 'Qatar Airways Cargo', type: 'Airline' },
  { name: 'Biman Bangladesh Airlines', type: 'Airline' },
  { name: 'Turkish Cargo', type: 'Airline' },
] as const;

/**
 * Purchase & Sales lookups (docs/MODULE_PURCHASE_SALES.md §3.1).
 *
 * rate_tier is the table §2 exists for: the wireframe's four columns are these
 * rows. Adding a MIN charge or a -45 air break is one row here, not a migration
 * and a UI rewrite.
 */
const RATE_LOOKUPS = {
  /**
   * The client sorts cargo three ways, and it is the garment trade: Textile,
   * Non-Textile, DG. The earlier General/Project/Personal/Reefer list was our
   * guess and is deactivated by migration rather than deleted, because eight
   * rates were priced against it.
   *
   * Reefer is absent on purpose — it is a container type, and lives there now.
   */
  goodsType: [
    { code: 'TEXTILE', name: 'Textile' },
    { code: 'NONTEXTILE', name: 'Non-Textile' },
    { code: 'DG', name: 'DG' },
  ],
  /** How big the box is. */
  containerSize: [
    { code: '20STD', name: "20' Standard", teuFactor: '1.00', sortOrder: 1 },
    { code: '40STD', name: "40' Standard", teuFactor: '2.00', sortOrder: 2 },
    { code: '40HC', name: "40' High Cube", teuFactor: '2.00', sortOrder: 3 },
    { code: '45FT', name: "45' High Cube", teuFactor: '2.25', sortOrder: 4 },
  ],
  /**
   * What kind of box it is — a different axis entirely. A 40HC can be Dry or
   * Reefer and the price is not remotely the same.
   */
  containerType: [
    { code: 'DRY', name: 'Dry', sortOrder: 1 },
    { code: 'FLATRACK', name: 'Flat Rack', sortOrder: 2 },
    { code: 'OPENTOP', name: 'Open Top', sortOrder: 3 },
    { code: 'REEFER', name: 'Reefer', sortOrder: 4 },
  ],
  /**
   * TOS — the eleven Incoterms 2020 rules, in their canonical order. EXW…DDP
   * apply to any transport mode; FAS, FOB, CFR and CIF are sea and inland
   * waterway only, noted in the name rather than enforced, since the client did
   * not ask for that rule.
   */
  tos: [
    { code: 'EXW', name: 'EXW — Ex Works', sortOrder: 1 },
    { code: 'FCA', name: 'FCA — Free Carrier', sortOrder: 2 },
    { code: 'FAS', name: 'FAS — Free Alongside Ship (sea only)', sortOrder: 3 },
    { code: 'FOB', name: 'FOB — Free On Board (sea only)', sortOrder: 4 },
    { code: 'CFR', name: 'CFR — Cost and Freight (sea only)', sortOrder: 5 },
    { code: 'CIF', name: 'CIF — Cost, Insurance and Freight (sea only)', sortOrder: 6 },
    { code: 'CPT', name: 'CPT — Carriage Paid To', sortOrder: 7 },
    { code: 'CIP', name: 'CIP — Carriage and Insurance Paid To', sortOrder: 8 },
    { code: 'DPU', name: 'DPU — Delivered at Place Unloaded', sortOrder: 9 },
    { code: 'DAP', name: 'DAP — Delivered at Place', sortOrder: 10 },
    { code: 'DDP', name: 'DDP — Delivered Duty Paid', sortOrder: 11 },
  ],
  /**
   * Mode — where the carrier takes the cargo and where it hands it back.
   *
   * This is the documented assumption, not a stated client rule: open question
   * 1 of the module spec. No values were invented for it — these are the seven
   * the product already had.
   */
  mode: [
    { code: 'CY/CY', name: 'CY / CY' },
    { code: 'CY/CFS', name: 'CY / CFS' },
    { code: 'CFS/CY', name: 'CFS / CY' },
    { code: 'CFS/CFS', name: 'CFS / CFS' },
    { code: 'DOOR/DOOR', name: 'Door / Door' },
    { code: 'DOOR/CY', name: 'Door / CY' },
    { code: 'CY/DOOR', name: 'CY / Door' },
  ],
  inquirySource: [
    { code: 'CALL', name: 'Direct Call' },
    { code: 'EMAIL', name: 'Email' },
    { code: 'WEBSITE', name: 'Website' },
    { code: 'AGENT', name: 'Agent Referral' },
    { code: 'EXISTING', name: 'Existing Customer' },
    { code: 'EXHIBITION', name: 'Exhibition' },
    { code: 'FIELD', name: 'Field Visit' },
  ],
} as const;

/** Tier definitions per mode. Sea FCL tiers link to a container type. */
const RATE_TIERS = [
  { code: 'FCL-20STD', mode: 'SEA_FCL', label: '20STD', unit: 'CONTAINER', container: '20STD', sortOrder: 1 },
  { code: 'FCL-40STD', mode: 'SEA_FCL', label: '40STD', unit: 'CONTAINER', container: '40STD', sortOrder: 2 },
  { code: 'FCL-40HC', mode: 'SEA_FCL', label: '40HC', unit: 'CONTAINER', container: '40HC', sortOrder: 3 },
  { code: 'FCL-45FT', mode: 'SEA_FCL', label: '45FT', unit: 'CONTAINER', container: '45FT', sortOrder: 4 },
  { code: 'LCL-0-5', mode: 'SEA_LCL', label: '0-5', unit: 'CBM', min: '0', max: '5', sortOrder: 1 },
  { code: 'LCL-5-10', mode: 'SEA_LCL', label: '5-10', unit: 'CBM', min: '5', max: '10', sortOrder: 2 },
  { code: 'LCL-10-15', mode: 'SEA_LCL', label: '10-15', unit: 'CBM', min: '10', max: '15', sortOrder: 3 },
  { code: 'LCL-15PLUS', mode: 'SEA_LCL', label: '15+', unit: 'CBM', min: '15', max: null, sortOrder: 4 },
  { code: 'AIR-100', mode: 'AIR', label: '100+', unit: 'KG', min: '100', max: null, sortOrder: 1 },
  { code: 'AIR-300', mode: 'AIR', label: '300+', unit: 'KG', min: '300', max: null, sortOrder: 2 },
  { code: 'AIR-500', mode: 'AIR', label: '500+', unit: 'KG', min: '500', max: null, sortOrder: 3 },
  { code: 'AIR-1000', mode: 'AIR', label: '1000+', unit: 'KG', min: '1000', max: null, sortOrder: 4 },
] as const;

/** System lookup values from §5 and §6. tenant_id stays NULL — see §7A rule 7. */
const SYSTEM_LOOKUPS = {
  costUnit: ['Container', 'HBL', 'HAWB', 'MBL', 'MAWB', 'CBM', 'Trip', 'Contract', 'M.Ton', 'KG'],
  carrierType: ['MLO', 'NVOCC', 'Airline', 'SOC'],
  vendorType: ['LCL', 'Air-Master Coloader'],
  /*
   * Appended only, never reordered. The seeder keys these by a code derived
   * from the array index (EXA-001, EXA-002...) and renames whatever holds that
   * code — so inserting one in the middle would silently retitle every expert
   * area after it, on a production database, under agents already tagged with
   * them.
   */
  expertArea: [
    'Sea-FCL',
    'Sea-LCL',
    'Air-General',
    'Air-DG',
    'Sea-DG',
    'Project',
    'SCM',
    // Added 2026-08-29 at the client's request.
    'Door 2 Door',
    'Customs Clearance',
    'Trucking',
    'Courier - Parcel',
  ],
  network: ['WCA', 'JCtrans', 'GLA', 'OLO'],
} as const;

async function seedPermissions(): Promise<number> {
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: {
        module: permission.module,
        feature: permission.feature,
        action: permission.action,
      },
      create: {
        module: permission.module,
        feature: permission.feature,
        action: permission.action,
        key: permission.key,
      },
    });
  }
  return PERMISSIONS.length;
}

async function seedSystemLookups(): Promise<number> {
  let count = 0;

  const tables = [
    { rows: SYSTEM_LOOKUPS.costUnit, prefix: CODE_PREFIX.costUnit, model: prisma.costUnit },
    { rows: SYSTEM_LOOKUPS.carrierType, prefix: CODE_PREFIX.carrierType, model: prisma.carrierType },
    { rows: SYSTEM_LOOKUPS.vendorType, prefix: CODE_PREFIX.vendorType, model: prisma.vendorType },
    { rows: SYSTEM_LOOKUPS.expertArea, prefix: CODE_PREFIX.expertArea, model: prisma.expertArea },
    { rows: SYSTEM_LOOKUPS.network, prefix: CODE_PREFIX.network, model: prisma.network },
  ];

  for (const table of tables) {
    for (const [index, name] of table.rows.entries()) {
      const code = formatCode(table.prefix, index + 1);
      // System rows have tenant_id NULL, so the composite unique cannot be used
      // to upsert; the partial unique index on (code) WHERE tenant_id IS NULL
      // is what actually guarantees uniqueness here.
      const existing = await table.model.findFirst({
        where: { code, tenantId: null },
        select: { id: true },
      });
      if (existing === null) {
        await table.model.create({ data: { code, name } });
        count += 1;
      } else {
        await table.model.update({ where: { id: existing.id }, data: { name } });
      }
    }
  }

  return count;
}

/**
 * Shared master rows. Idempotent on the natural key (port_code, currency name,
 * carrier name) rather than on `code`, so re-running never duplicates and never
 * renumbers.
 */
async function seedSystemMasters(): Promise<{ ports: number; currencies: number; carriers: number }> {
  let ports = 0;
  for (const [index, port] of SYSTEM_PORTS.entries()) {
    const existing = await prisma.port.findFirst({
      where: { portCode: port.portCode, tenantId: null },
      select: { id: true },
    });
    if (existing === null) {
      await prisma.port.create({
        data: {
          code: formatCode(CODE_PREFIX.port, index + 1),
          name: port.name,
          portCode: port.portCode,
          country: port.country,
          type: port.type,
        },
      });
      ports += 1;
    }
  }

  let currencies = 0;
  for (const [index, currency] of SYSTEM_CURRENCIES.entries()) {
    const existing = await prisma.currency.findFirst({
      where: { currency: currency.currency, tenantId: null },
      select: { id: true },
    });
    if (existing === null) {
      await prisma.currency.create({
        data: {
          code: formatCode(CODE_PREFIX.currency, index + 1),
          currency: currency.currency,
          conversion: currency.conversion,
        },
      });
      currencies += 1;
    }
  }

  const carrierTypes = await prisma.carrierType.findMany({
    where: { tenantId: null },
    select: { id: true, name: true },
  });
  const typeByName = new Map(carrierTypes.map((t) => [t.name, t.id]));

  let carriers = 0;
  for (const [index, carrier] of SYSTEM_CARRIERS.entries()) {
    const typeId = typeByName.get(carrier.type);
    if (typeId === undefined) continue; // carrier_type not seeded yet
    const existing = await prisma.carrier.findFirst({
      where: { name: carrier.name, tenantId: null },
      select: { id: true },
    });
    if (existing === null) {
      await prisma.carrier.create({
        data: {
          code: formatCode(CODE_PREFIX.carrier, index + 1),
          name: carrier.name,
          typeId,
        },
      });
      carriers += 1;
    }
  }

  return { ports, currencies, carriers };
}

/** The §3.1 Purchase & Sales lookups, as shared rows. */
async function seedRateLookups(): Promise<number> {
  let created = 0;

  const simple = [
    { rows: RATE_LOOKUPS.goodsType, prefix: CODE_PREFIX.goodsType, model: prisma.goodsType },
    { rows: RATE_LOOKUPS.tos, prefix: CODE_PREFIX.tos, model: prisma.tos },
    { rows: RATE_LOOKUPS.mode, prefix: CODE_PREFIX.mode, model: prisma.mode },
    { rows: RATE_LOOKUPS.inquirySource, prefix: CODE_PREFIX.inquirySource, model: prisma.inquirySource },
  ];
  for (const table of simple) {
    for (const row of table.rows) {
      const existing = await table.model.findFirst({
        where: { code: row.code, tenantId: null },
        select: { id: true },
      });
      if (existing === null) {
        await table.model.create({ data: { code: row.code, name: row.name } });
        created += 1;
      }
    }
  }

  for (const row of RATE_LOOKUPS.containerSize) {
    const existing = await prisma.containerSize.findFirst({
      where: { code: row.code, tenantId: null },
      select: { id: true },
    });
    if (existing === null) {
      await prisma.containerSize.create({
        data: { code: row.code, name: row.name, teuFactor: row.teuFactor, sortOrder: row.sortOrder },
      });
      created += 1;
    }
  }

  for (const row of RATE_LOOKUPS.containerType) {
    const existing = await prisma.containerType.findFirst({
      where: { code: row.code, tenantId: null },
      select: { id: true },
    });
    if (existing === null) {
      await prisma.containerType.create({
        data: { code: row.code, name: row.name, sortOrder: row.sortOrder },
      });
      created += 1;
    }
  }

  // Tiers come last: the Sea FCL ones point at a container size.
  const containers = await prisma.containerSize.findMany({
    where: { tenantId: null },
    select: { id: true, code: true },
  });
  const containerByCode = new Map(containers.map((c) => [c.code, c.id]));

  for (const tier of RATE_TIERS) {
    const existing = await prisma.rateTier.findFirst({
      where: { code: tier.code, tenantId: null },
      select: { id: true },
    });
    if (existing !== null) continue;
    await prisma.rateTier.create({
      data: {
        code: tier.code,
        mode: tier.mode,
        label: tier.label,
        unit: tier.unit,
        sortOrder: tier.sortOrder,
        minValue: 'min' in tier && tier.min !== null ? tier.min : null,
        maxValue: 'max' in tier && tier.max !== null ? tier.max : null,
        containerSizeId:
          'container' in tier ? (containerByCode.get(tier.container) ?? null) : null,
      },
    });
    created += 1;
  }

  return created;
}


/**
 * The shipped email templates (module spec §2.3).
 *
 * Seeded as system rows — tenant_id null — so a new workspace can send mail on
 * its first day. A forwarder who wants their own wording writes a row with the
 * same key and their own tenant_id; resolveTemplate prefers it.
 *
 * `variables` is the contract: what the code supplies, and therefore what an
 * editor may use. The agent template does NOT list customerName, and the code
 * does not supply it — an agent must never learn who the shipper is, and the
 * only way to keep that true through a tenant-editable template is for the
 * value never to reach the renderer.
 */
/*
 * The client's own wording, from docs/Email Templet.docx.
 *
 * Two audiences, one letter. The carrier and the agent are asked the identical
 * question — quote this lane, with validity and surcharges — and the client
 * wrote them as two documents differing in a single line: the agent is told
 * where to submit, because the agent has a login and the carrier does not.
 *
 * Three things in their document are deliberately NOT baked in here:
 *
 *   the customer      never appears, and must not. §2.1 rule 2: an agent who
 *                     learns who the shipper is can approach them directly.
 *                     Their template does not name the customer either, which
 *                     is the client agreeing with the rule rather than an
 *                     accident to be tidied up.
 *   the signer        "Tanjila Sathi, Sr. Executive" is a person, not a
 *                     constant. It resolves from the inquiry's salesman, so
 *                     the reply goes to whoever is actually working the lane.
 *   the company block their Banani and Chattogram addresses are Triple S's.
 *                     These templates are shared rows every workspace falls
 *                     back to, so the block comes from the workspace's own
 *                     notification settings via {{signature}}.
 *
 * A placeholder with no value renders empty, so a workspace that has filled in
 * none of this still sends a correct, if unsigned, letter.
 */
const RFQ_BODY = [
  'Dear Sir/Madam,',
  '',
  'Hope you are doing well.',
  '',
  'We are currently working to secure the below shipment and would appreciate',
  'your best possible freight rate:',
  '',
  'Commodity: {{commodity}}',
  'POL: {{polLabel}}',
  'POD: {{podLabel}}',
  'Volume: {{volume}}',
  'Expected Shipment Date: {{expectedShipmentDate}}',
  '',
  'Could you please quote your most competitive rate for the above shipment,',
  'along with the applicable validity and any relevant surcharges?',
];

const RFQ_SIGN_OFF = [
  '',
  'Your prompt support and best rate would be highly appreciated.',
  '',
  'Kind regards,',
  '{{senderName}}',
  '{{senderDesignation}}',
  '',
  '{{signature}}',
];

const EMAIL_TEMPLATES = [
  {
    key: 'INQUIRY_AGENT_RFQ',
    name: 'Inquiry — rate request to an agent',
    subject: 'Rate Request. POL: {{polLabel}}, POD: {{podLabel}}, Inquiry No: {{code}}',
    bodyText: [
      ...RFQ_BODY,
      '',
      // The one line that differs from the carrier's letter.
      'Submit your quotation at {{link}}',
      "If you don't have a user ID and password, please contact me.",
      ...RFQ_SIGN_OFF,
    ].join('\n'),
    variables: [
      'code',
      'polLabel',
      'podLabel',
      'commodity',
      'volume',
      'expectedShipmentDate',
      'senderName',
      'senderDesignation',
      'signature',
      'link',
    ],
  },
  {
    key: 'INQUIRY_CARRIER_RFQ',
    name: 'Inquiry — rate request to a carrier',
    subject: 'Rate Request. POL: {{polLabel}}, POD: {{podLabel}}, Inquiry No: {{code}}',
    // No submission link: a carrier has no login, and the reply comes back by
    // email to the salesman who signed it.
    bodyText: [...RFQ_BODY, ...RFQ_SIGN_OFF].join('\n'),
    variables: [
      'code',
      'polLabel',
      'podLabel',
      'commodity',
      'volume',
      'expectedShipmentDate',
      'senderName',
      'senderDesignation',
      'signature',
    ],
  },
  {
    key: 'INQUIRY_PRICE_TEAM',
    name: 'Inquiry — no live rate, please obtain one',
    subject: 'Rate needed — {{code}} ({{polLabel}} → {{podLabel}})',
    // Internal, so this one may name the customer.
    bodyText: [
      'This outbound lane has no live buying rate. Please obtain one from a carrier.',
      '',
      'Inquiry:   {{code}}',
      'Customer:  {{customerName}}',
      'Lane:      {{polLabel}} → {{podLabel}}',
      'Movement:  {{movement}}',
      '',
      'Open it here: {{link}}',
    ].join('\n'),
    variables: ['code', 'customerName', 'polLabel', 'podLabel', 'movement', 'link'],
  },
  {
    key: 'AGENT_QUOTE_SUBMITTED',
    name: 'Agent quotation received',
    subject: 'Quotation received — {{code}} ({{agentName}})',
    bodyText: [
      '{{agentName}} has submitted a quotation for inquiry {{code}}.',
      '',
      'The price is on the inquiry rather than in this email.',
      '',
      'Open it here: {{link}}',
    ].join('\n'),
    variables: ['agentName', 'code', 'link'],
  },
  {
    // MODULE_BOOKING_CARGO.md §6.4: "Save -> status VESSEL_PROPOSED, notify the
    // customer by email." The schedule itself is on the record rather than in
    // the letter — a sailing changes, and a mail nobody can correct is how a
    // customer ends up holding a date we no longer offer.
    key: 'SHIPMENT_SCHEDULE_PROPOSED',
    name: 'Booking — vessel or flight schedule proposed',
    subject: 'Schedule proposed for booking {{bookingNo}}',
    bodyText: [
      'Dear {{customerName}},',
      '',
      'We have proposed a {{modeWord}} schedule for your booking {{bookingNo}}.',
      '',
      'Carrier: {{carrierName}}',
      'Routing: {{routing}}',
      'Departure: {{etd}}',
      'Arrival: {{eta}}',
      '',
      'Please review and approve it here: {{link}}',
      '',
      'If the schedule does not suit, reject it with your comments and we will',
      'propose another.',
    ].join('\n'),
    variables: [
      'customerName',
      'bookingNo',
      'modeWord',
      'carrierName',
      'routing',
      'etd',
      'eta',
      'link',
    ],
  },
  {
    // MODULE_BOOKING_CARGO.md §6.5: "On decision: update PO statuses,
    // transition the shipment, email the C/S team." The summary is §5.3's own
    // sentence, because the number that matters is how many POs will actually
    // ship — not whether somebody clicked approve.
    key: 'SHIPMENT_APPROVAL_DECIDED',
    name: 'Booking — customer decided on the schedule',
    subject: 'Booking {{bookingNo}} — schedule {{outcome}}',
    bodyText: [
      '{{customerName}} has {{outcome}} the proposed schedule for {{bookingNo}}.',
      '',
      '{{summary}}',
      '',
      'Recorded by: {{decidedBy}}',
      'Comments: {{comments}}',
      '',
      'Open the booking here: {{link}}',
    ].join('\n'),
    variables: [
      'customerName',
      'bookingNo',
      'outcome',
      'summary',
      'decidedBy',
      'comments',
      'link',
    ],
  },
] as const;

/**
 * The product's default letters.
 *
 * The shared row (tenant_id NULL) is the product's own wording, so when that
 * wording changes the row is refreshed rather than skipped — otherwise a fix to
 * a template only ever reaches workspaces created after it, which is not a
 * default at all. §7A rule 7 stops a tenant editing a shared row, so nothing
 * anyone typed is at risk here.
 *
 * A workspace that wants its own wording gets a tenant-owned row instead, and
 * this never touches those.
 */
async function seedEmailTemplates(): Promise<number> {
  let created = 0;
  for (const [index, row] of EMAIL_TEMPLATES.entries()) {
    const existing = await prisma.emailTemplate.findFirst({
      where: { key: row.key, tenantId: null, deletedAt: null },
      select: { id: true, subject: true, bodyText: true },
    });
    if (existing !== null) {
      if (existing.subject !== row.subject || existing.bodyText !== row.bodyText) {
        await prisma.emailTemplate.update({
          where: { id: existing.id },
          data: {
            name: row.name,
            subject: row.subject,
            bodyText: row.bodyText,
            variables: [...row.variables],
          },
        });
      }
      continue;
    }
    await prisma.emailTemplate.create({
      data: {
        code: formatCode(CODE_PREFIX.emailTemplate, index + 1),
        key: row.key,
        name: row.name,
        subject: row.subject,
        bodyText: row.bodyText,
        variables: [...row.variables],
      },
    });
    created += 1;
  }
  return created;
}

/**
 * A development tenant with a superadmin. Guarded by an explicit flag so it can
 * never run against production by accident.
 */
/**
 * Creates one workspace and its first superadmin.
 *
 * The name and slug are overridable because this is also how the FIRST real
 * workspace gets created on a deployment — §7A rule 6's zero-touch onboarding
 * and the §7B platform console are not built yet, so there is no other way in.
 * The defaults keep local development exactly as it was.
 *
 * The slug is the subdomain: slug `acme` is served at acme.yourdomain.com.
 */
async function seedDevTenant(): Promise<void> {
  const slug = process.env['SEED_TENANT_SLUG'] ?? 'demo';
  const name = process.env['SEED_TENANT_NAME'] ?? 'Demo Freight Ltd';
  const country = process.env['SEED_TENANT_COUNTRY'] ?? 'Bangladesh';
  const username = normalizeUsername('superadmin');
  const password = process.env['SEED_SUPERADMIN_PASSWORD'] ?? 'ChangeMe!2026';

  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new Error(
      `SEED_TENANT_SLUG="${slug}" is not usable as a subdomain. ` +
        'Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.',
    );
  }

  const tenant = await prisma.tenant.upsert({
    where: { slug },
    update: {},
    create: {
      name,
      slug,
      country,
      timezone: 'Asia/Dhaka',
      status: 'TRIAL',
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    },
    select: { id: true },
  });

  // §7: role templates exist for speed; per-user overrides still win.
  const existingRole = await prisma.role.findFirst({
    where: { tenantId: tenant.id, code: formatCode(CODE_PREFIX.role, 1) },
    select: { id: true },
  });
  const role =
    existingRole ??
    (await prisma.role.create({
      data: {
        tenantId: tenant.id,
        code: formatCode(CODE_PREFIX.role, 1),
        name: 'Superadmin',
        description: 'Full access to every feature.',
        isSystem: true,
      },
      select: { id: true },
    }));

  // Give the template role every permission. The superadmin flag already
  // bypasses the check, but the role must be usable as a template for others.
  const allPermissions = await prisma.permission.findMany({ select: { id: true } });
  for (const permission of allPermissions) {
    const exists = await prisma.rolePermission.findFirst({
      where: { tenantId: tenant.id, roleId: role.id, permissionId: permission.id },
      select: { id: true },
    });
    if (exists === null) {
      await prisma.rolePermission.create({
        data: { tenantId: tenant.id, roleId: role.id, permissionId: permission.id },
      });
    }
  }

  const passwordHash = await hash(password, {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const existingUser = await prisma.user.findFirst({
    where: { tenantId: tenant.id, username },
    select: { id: true },
  });

  if (existingUser === null) {
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        code: formatCode(CODE_PREFIX.user, 1),
        username,
        email: 'superadmin@demo.local',
        passwordHash,
        roleId: role.id,
        isSuperadmin: true,
      },
    });
  } else {
    await prisma.user.update({
      where: { id: existingUser.id },
      data: { passwordHash, roleId: role.id, isSuperadmin: true, isActive: true },
    });
  }

  console.log(`  tenant     : ${slug} (workspace ${tenant.id})`);
  console.log(`  superadmin : ${username} / ${password}`);
}

async function main(): Promise<void> {
  console.log('Seeding...');

  const permissions = await seedPermissions();
  console.log(`  permissions: ${permissions}`);

  const templates = await seedEmailTemplates();
  console.log(`  email templates: ${templates} created (idempotent)`);

  const lookups = await seedSystemLookups();
  console.log(`  system lookups: ${lookups} created (idempotent)`);

  const masters = await seedSystemMasters();
  console.log(
    `  system masters: ${masters.ports} ports, ${masters.currencies} currencies, ${masters.carriers} carriers created (idempotent)`,
  );

  const rateLookups = await seedRateLookups();
  console.log(`  rate lookups  : ${rateLookups} created (idempotent)`);

  if (process.env['SEED_DEV_TENANT'] === 'true') {
    await seedDevTenant();
  } else {
    console.log('  dev tenant : skipped (set SEED_DEV_TENANT=true to create it)');
  }

  console.log('Done.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
