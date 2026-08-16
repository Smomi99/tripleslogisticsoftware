/**
 * Database seed.
 *
 * Fills in from Phase 3 (CLAUDE.md §9): the permission registry from the shared
 * code constant, a Superadmin role, one superadmin user, and the §5–§6 lookup
 * values (cost units, carrier types, vendor types, expert areas, networks).
 *
 * Exists now so `prisma migrate reset` has something to call.
 */
async function main(): Promise<void> {
  console.log('Seed: nothing to insert yet — schema lands in Phase 1.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
