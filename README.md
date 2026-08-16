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
pnpm db:generate          # generate the Prisma client
pnpm dev                  # web on :3000, API on :4000
```

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
| `pnpm db:studio` | Prisma Studio |
| `pnpm db:reset` | Drop, re-migrate and re-seed |

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
- **Never import `prisma` directly in feature code** — from Phase 2 it is wrapped in a
  tenant-scoped extension (CLAUDE.md §7A rule 3).

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

Phase 0 of the plan in CLAUDE.md §13 is complete: monorepo scaffold, no business logic.
Next up is Phase 1 — the §5 Settings and §6 CRM schema.
