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

/** System lookup values from §5 and §6. tenant_id stays NULL — see §7A rule 7. */
const SYSTEM_LOOKUPS = {
  costUnit: ['Container', 'HBL', 'HAWB', 'MBL', 'MAWB', 'CBM', 'Trip', 'Contract', 'M.Ton', 'KG'],
  carrierType: ['MLO', 'NVOCC', 'Airline', 'SOC'],
  vendorType: ['LCL', 'Air-Master Coloader'],
  expertArea: ['Sea-FCL', 'Sea-LCL', 'Air-General', 'Air-DG', 'Sea-DG', 'Project', 'SCM'],
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

/**
 * A development tenant with a superadmin. Guarded by an explicit flag so it can
 * never run against production by accident.
 */
async function seedDevTenant(): Promise<void> {
  const slug = 'demo';
  const username = normalizeUsername('superadmin');
  const password = process.env['SEED_SUPERADMIN_PASSWORD'] ?? 'ChangeMe!2026';

  const tenant = await prisma.tenant.upsert({
    where: { slug },
    update: {},
    create: {
      name: 'Demo Freight Ltd',
      slug,
      country: 'Bangladesh',
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

  const lookups = await seedSystemLookups();
  console.log(`  system lookups: ${lookups} created (idempotent)`);

  const masters = await seedSystemMasters();
  console.log(
    `  system masters: ${masters.ports} ports, ${masters.currencies} currencies, ${masters.carriers} carriers created (idempotent)`,
  );

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
