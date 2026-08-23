# Deploying free — Vercel + Neon + Cloudflare R2

A working deployment of this ERP on free plans, for showing the client and for
staging. Read §7 before putting a paying customer's shipment records on it.

CLAUDE.md still governs everything. Nothing here changes the schema, the RBAC
model or the tenant boundary — it only changes where the processes run and how
the tenant is named.

---

## 1. The shape

```
Browser
  │
  └── https://ff-erp.vercel.app          Vercel project #1 — apps/web (Next.js)
        ├── /…                            pages, server components
        └── /api/*  ── rewrite ──►        Vercel project #2 — apps/api (Express)
                                            ├── Neon Postgres      (free)
                                            └── Cloudflare R2      (free, 10 GB)
```

Three decisions worth understanding before you follow the steps:

**The API is proxied, not called directly.** The refresh token is an httpOnly
`SameSite=Lax` cookie (§2). Lax means the browser withholds it from cross-site
requests — so a web app on one host calling an API on another signs in fine and
then silently fails to refresh fifteen minutes later. `next.config.ts` rewrites
`/api/*` to the API deployment, keeping every request first-party. CORS stops
mattering entirely.

**One deployment serves one workspace.** §7A rule 5 addresses a tenant by
subdomain (`acme.yourapp.com`), which needs wildcard DNS — a paid feature on
Vercel, Render and Netlify alike. `DEFAULT_TENANT_SLUG` names the workspace in
server-side configuration instead. This does not weaken §7A rule 1: it is
operator config, not client input, and a caller still cannot name a tenant it
does not belong to. Unset it the day you have wildcard DNS.

**Uploads must leave the filesystem.** Vercel's disk is read-only apart from
`/tmp`, and `/tmp` dies with the instance. `STORAGE_DRIVER=s3` is not optional
here. R2's free tier is 10 GB with no egress charge, and it speaks S3.

---

## 2. Postgres — Neon

Neon's free tier fits this app specifically: it allows `CREATE ROLE` and
`CREATE EXTENSION btree_gist`, both of which the migrations need, and its
pooled endpoint is PgBouncer in transaction mode — which is safe here because
`set_config('app.tenant_id', …, true)` is transaction-local and cannot leak
into the next request that borrows the connection (§7A rule 2).

1. Create a project at neon.tech. Pick the region nearest Dhaka (`ap-southeast-1`).
2. Copy **both** connection strings from the dashboard:
   - the **direct** (unpooled) one — for migrations, which run DDL
   - the **pooled** one — for the runtime
3. Run the migrations from your machine, as the owner:

   ```bash
   DATABASE_URL="<direct-url>" pnpm prisma migrate deploy
   ```

   This creates the tables, the RLS policies, the 28 cross-tenant parent
   triggers, and the `ff_app` role as `NOLOGIN`.

4. Give `ff_app` a real password. **Do not skip this and do not point the API
   at the owner URL** — a table owner bypasses RLS, and every tenant boundary
   in the system quietly stops binding (§7A rule 2). `scripts/dev-db-app-role.sql`
   is the local-only version of this with a well-known password; production
   needs its own secret.

   ```bash
   DATABASE_URL="<direct-url>" pnpm prisma db execute --stdin <<'SQL'
   ALTER ROLE ff_app LOGIN PASSWORD '<a-long-random-secret>';
   SQL
   ```

5. Build the runtime URL by swapping the credentials of the **pooled** string
   for `ff_app` and that password. That is `DATABASE_URL_APP`.

6. Seed permissions, lookup values, the workspace and the first superadmin:

   ```bash
   DATABASE_URL="<direct-url>" \
   SEED_DEV_TENANT=true \
   SEED_SUPERADMIN_PASSWORD='<something-you-choose>' \
     pnpm db:seed
   ```

   The workspace this creates has the slug `demo`. That is the value both
   `DEFAULT_TENANT_SLUG` and `NEXT_PUBLIC_TENANT_SLUG` must carry below.

---

## 3. Object storage — Cloudflare R2

1. Cloudflare dashboard → R2 → create a bucket, e.g. `ff-erp-files`.
> **Verify it before trusting it.** With the four `S3_*` values set, run
> `pnpm --filter @ff/api storage:check`. It writes an object, reads it back,
> compares the bytes and deletes it — the same path an upload takes. A
> misconfigured bucket is otherwise invisible until the first file someone
> attaches.

2. Create an **R2 API token** with Object Read & Write on that bucket. You get
   an access key id and a secret.
3. The endpoint is `https://<account-id>.r2.cloudflarestorage.com`.

Keep the bucket private. Files are streamed through the API, which re-derives
the tenant prefix from the session and refuses a key belonging to anyone else —
a public bucket would hand out every tenant's agreements to anyone who guesses
a UUID.

---

## 4. The API — Vercel project #2

Create it first; the web app needs its URL.

**Import the repo → Root Directory `apps/api` → Framework Preset "Other".**

`apps/api/vercel.json` rewrites every path to the function, so Express still
sees the original URL and its `/api/tenant/…` mounts match unchanged. The
`vercel-build` script runs `prisma generate` from the repo root, because the
generated client is gitignored.

Environment variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the **direct** Neon URL (owner) |
| `DATABASE_URL_APP` | the **pooled** Neon URL as `ff_app` |
| `JWT_ACCESS_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `JWT_REFRESH_SECRET` | a second, different one |
| `WEB_ORIGIN` | the web app's URL (below) |
| `DEFAULT_TENANT_SLUG` | `demo` |
| `STORAGE_DRIVER` | `s3` |
| `S3_BUCKET` | `ff-erp-files` |
| `S3_REGION` | `auto` |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | from the R2 token |

Deploy, then check `https://<api>.vercel.app/api/health`.

---

## 5. The web app — Vercel project #1

**Import the same repo again → Root Directory `apps/web` → Next.js is detected.**

| Variable | Value |
|---|---|
| `API_ORIGIN` | `https://<api>.vercel.app` |
| `NEXT_PUBLIC_API_URL` | **this project's own URL** |
| `NEXT_PUBLIC_TENANT_SLUG` | `demo` — must match `DEFAULT_TENANT_SLUG` |

`NEXT_PUBLIC_API_URL` pointing at itself is what makes requests same-origin and
keeps the refresh cookie working; the rewrite then forwards them to the API
project. You will not know this URL until the first deploy — deploy once, set
it, redeploy.

Then go back and set `WEB_ORIGIN` on the API project to this URL.

Sign in at `/login` with `superadmin` and the password you seeded.

---

## 6. The nightly job that will not run

`pnpm --filter @ff/api rates:expire` moves lapsed purchase rates to `EXPIRED`.
It is a command, not a scheduler, and **nothing on this deployment invokes it**.
Until it runs, the price list keeps offering lanes whose validity has passed —
quotable rates that should not be quotable.

Vercel Hobby allows one cron per day, which is exactly the cadence this needs,
but it triggers an HTTP endpoint and no such endpoint exists yet. Until one is
built, run the command by hand against the production database, or accept that
expiry is manual and say so to whoever is quoting.

---

## 7. What free actually costs you

- **Vercel's Hobby plan is for non-commercial use.** Fine for a demo and for
  staging; billing a client for a product served from it is outside its terms.
- **Function timeout.** Hobby caps execution at 60s (`vercel.json` asks for it;
  lower it if the platform refuses). The Excel and PDF exports are the only
  routes likely to approach that, and only on large price lists.
- **Neon free autosuspends** after five minutes idle. The first request after a
  quiet spell pays roughly half a second to wake the compute — noticeable, not
  painful. Storage is capped at 0.5 GB.
- **No backups worth the name.** This is the one that matters. A freight
  forwarder's BLs, invoices and shipment records are the company's operational
  memory; a free database tier makes no promise about keeping them. Before real
  data lands here, set up `pg_dump` on a schedule you control.
- **No wildcard DNS, so one workspace per deployment.** Multi-tenancy is fully
  built and fully tested — it is the hosting that cannot express it yet.

When the client starts paying, the smallest honest upgrade is a ~$4/mo VPS
(Hetzner CX22) running the whole stack under Docker Compose with Caddy: real
wildcard subdomains, a real disk, and backups you control. Nothing in the code
changes.

---

## 8. Alternative for the API — Render

`render.yaml` at the repo root deploys `src/server.ts` as a real long-running
process instead of a serverless function: one connection pool for the instance,
no per-request cold start, no serverless caveats.

The catch is that Render's free plan stops the service after 15 minutes of
inactivity, and the next request pays about a minute of start-up. During a
demo, that is the first click of every session hanging — which is why the
Vercel function is the default recommendation. Everything else is identical,
including the need for R2: Render's free disk does not survive a restart
either.

Point the web app's `API_ORIGIN` at the Render URL instead, and nothing else
differs.
