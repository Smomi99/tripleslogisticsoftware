# Freight Forwarding ERP

Multi-tenant freight forwarding / logistics ERP.
**[CLAUDE.md](CLAUDE.md) is the specification and the single source of truth** — read it before
changing anything. This README only covers how to run the repo.

## Requirements

- Node.js ≥ 20.11 (developed on 24.14)
- pnpm 11 (`npm install -g pnpm`)
- Docker Desktop (for Postgres)

## Getting started

```bash
pnpm install
cp .env.example .env      # adjust if your ports differ
pnpm db:up                # start Postgres 16 in Docker
pnpm db:migrate           # create the schema and RLS policies
pnpm db:app-role          # grant the ff_app role a local login (once)
pnpm db:generate          # generate the Prisma client
pnpm db:seed              # permissions, system lookups, demo workspace
pnpm dev                  # web on :3000, API on :4000
pnpm test                 # tenancy + RBAC suites
```

Sign in against the demo workspace with `superadmin` / `ChangeMe!2026`. Locally the workspace is
addressed with an `X-Tenant-Slug: demo` header, since `demo.localhost` needs wildcard DNS; in
production it is the subdomain.

Check it came up: <http://localhost:3000> should report the API reachable and the database up.

## Layout

| Path | What lives there |
|---|---|
| `apps/web` | Next.js 16 App Router frontend |
| `apps/api` | Express 5 API service — the only thing that talks to Postgres |
| `packages/shared` | Zod schemas, types, permission constants shared by both |
| `prisma/` | `schema.prisma`, migrations, seed |
| `prisma.config.ts` | Prisma 7 config — datasource URL lives here, not in the schema |

## Scripts

| Command | Does |
|---|---|
| `pnpm dev` | Runs API and web together |
| `pnpm build` | Production build of both |
| `pnpm typecheck` | `tsc --noEmit` across all packages |
| `pnpm db:up` / `db:down` | Start / stop the Postgres container |
| `pnpm db:migrate` | `prisma migrate dev` |
| `pnpm db:generate` | Regenerate the Prisma client |
| `pnpm db:seed` | Permissions, system lookups, and the demo workspace |
| `pnpm db:app-role` | Grant the non-owner `ff_app` role a local login (once) |
| `pnpm db:studio` | Prisma Studio |
| `pnpm db:reset` | Drop, re-migrate and re-seed — **destroys all data** |
| `pnpm test` | Tenancy isolation and RBAC suites |

## Conventions worth knowing before you write code

- **Imports are extensionless** (`from './config/env'`). The repo is on
  `moduleResolution: "Bundler"`; Turbopack cannot resolve the `.js`-for-`.ts` form in
  `packages/shared`.
- **The Prisma client is generated into `apps/api/src/generated/prisma`** and is gitignored — run
  `pnpm db:generate` after pulling a schema change. The API is its only consumer; the web app
  reaches the database over HTTP only.
- **`apps/api` is bundled with tsup, not `tsc`.** Both `@ff/shared` and the generated Prisma client
  ship as TypeScript source, so a file-by-file transpile can't build them. Type checking is a
  separate step.
- **Never import `prisma` directly in feature code.** Use `withTenant(tenantId, db => ...)` from
  [apps/api/src/lib/tenant-client.ts](apps/api/src/lib/tenant-client.ts). It scopes every query and
  sets `app.tenant_id` for the RLS policies, inside one transaction.
- **Two database roles, and the distinction is load-bearing.** `ff_erp` owns the tables and is used
  only by migrations, the seed and tests; it *bypasses RLS*. `ff_app` owns nothing, has no `DELETE`
  grant anywhere, and is what the API connects as. Pointing `DATABASE_URL_APP` at `ff_erp` makes
  every tenant boundary vanish while everything still appears to work.
- **A new table must be added to `apps/api/src/lib/tenancy.ts`** and given an RLS policy. The
  isolation suite fails if a table exists in the database but not in that registry, so it cannot
  quietly default to unscoped.
- **Prisma must own every database object.** A constraint created only in hand-written migration
  SQL is invisible to `schema.prisma`, so the next `prisma migrate dev` generates a migration that
  drops it. Anything Prisma *can* model belongs in the schema; the appendix is only for what it
  genuinely cannot express (generated columns, partial and expression indexes).
- **Permissions come from `packages/shared/src/permissions.ts`**, nowhere else. The seed derives the
  `permission` table from it and `requirePermission` throws at startup on a key it does not define.

## Agent skills

`prisma init` vendors Prisma 7 skills into `.agents/skills/` (committed). Prisma 7 changed enough
from v6 — driver adapters, datasource URL in `prisma.config.ts` — that these are worth keeping.
`.claude/skills/` is only junctions onto them and is gitignored; after cloning, recreate it with:

```powershell
foreach ($d in Get-ChildItem .agents\skills -Directory) {
  New-Item -ItemType Junction -Path ".claude\skills\$($d.Name)" -Target $d.FullName
}
```

```bash
mkdir -p .claude/skills && for d in .agents/skills/*/; do ln -sfn "../../$d" ".claude/skills/$(basename "$d")"; done
```

`apps/web/AGENTS.md` and `apps/web/CLAUDE.md` are written by `next dev` itself and are committed
deliberately — deleting them just recreates an uncommitted change.

## Build status

Phases 0–2 of the plan in CLAUDE.md §13 are complete:

- **0** — monorepo scaffold
- **1** — §5 Settings and §6 CRM schema, 36 tables, migration applied
- **2** — tenancy layer: tenant resolution, the Prisma tenant-scoped extension, RLS policies on 34
  tables, and the two-tenant isolation suite (§7A rule 4)
- **3** — auth and §7 RBAC: permission registry, roles, per-user ALLOW/DENY, `requirePermission`,
  and the seed. 35 tests pass.

Next up is Phase 4 — the §12 design system and app shell.
