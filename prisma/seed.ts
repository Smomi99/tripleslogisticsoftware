// Loads .env from the repo root. Needed when the seed is run directly
// (`pnpm db:seed`) rather than through prisma.config.ts.
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from '@node-rs/argon2';

import { CODE_PREFIX, formatCode, PERMISSIONS } from '@ff/shared';

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
 * A development tenant with a superadmin. Guarded by an explicit flag so it can
 * never run against production by accident.
 */
async function seedDevTenant(): Promise<void> {
  const slug = 'demo';
  const username = 'superadmin';
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
