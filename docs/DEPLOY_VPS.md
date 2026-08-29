# Hosting on your own Ubuntu VPS

The proper deployment: real wildcard subdomains, so `acme.yourdomain.com` and
`globex.yourdomain.com` are two workspaces the way §7A rule 5 intends; a real
disk for uploads; backups you control; and no cold starts.

`docs/DEPLOY.md` is the free-tier alternative and is deliberately more limited.
This one supersedes it once you have a server.

CLAUDE.md still governs everything. Nothing here changes the schema, the RBAC
model or the tenant boundary.

---

## 1. What you are building

```
                        ┌──────────────────────────────────────────┐
  *.yourdomain.com ───► │ caddy      :80 :443   TLS, wildcard cert  │
                        │   ├── /api/*  ──►  api   :4000            │
                        │   └── /*      ──►  web   :3000            │
                        │                     └──►  postgres :5432  │
                        └──────────────────────────────────────────┘
                             one docker network, only 80/443 exposed
```

Four containers from `docker-compose.prod.yml`. Caddy is the only one on a
public port; Postgres is bound to the server's own loopback, reachable through
an SSH tunnel (§11) and from nowhere else.

Three things are load-bearing and easy to undo by accident:

**`/api/*` is served from the same hostname as the app.** The refresh token is
an httpOnly `SameSite=Lax` cookie (§2), so an API on its own subdomain would
sign users in and then silently stop refreshing fifteen minutes later. Same
host, one origin, no CORS.

**Caddy passes the `Host` header through untouched.** Both apps read the
workspace from the subdomain. nginx rewrites `Host` by default and would send
every workspace to the same tenant; Caddy does not, and the Caddyfile relies on
that.

**The API connects as `ff_app`, never as the owner.** A table owner bypasses
row-level security. Point `DATABASE_URL_APP` at `POSTGRES_USER` and every
tenant boundary in the product stops binding, with nothing in the logs.

### Sizing

| | |
|---|---|
| Comfortable | 2 vCPU, 4 GB RAM, 40 GB disk |
| Minimum | 2 GB RAM **with swap** (§3) |
| Will not work | 1 GB — `next build` runs out of memory partway through |

The two application images are roughly 1.4 GB each, and Docker keeps the
previous ones after an update until `docker image prune` runs. Budget disk
accordingly: 20 GB is tight, 40 GB is comfortable.

If your VPS is small, build the images on your laptop and push them to a
registry rather than building on the server (§12).

---

## 2. Prerequisites

- An Ubuntu 24.04 LTS VPS and its IP address.
- A domain, with DNS at Cloudflare (free tier is fine).
- An SSH key on your machine. If you do not have one:
  `ssh-keygen -t ed25519 -C "you@example.com"`.

---

## 3. Harden the server first

Do this before the app exists. A fresh VPS with password SSH is found by
scanners within minutes.

Log in as root, then create the user you will actually use:

```bash
adduser deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

From **your own machine**, confirm key login works before you lock the door:

```bash
ssh deploy@YOUR_SERVER_IP
```

Only once that succeeds, back on the server:

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/'            /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

Firewall — everything except SSH and the web:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Automatic security updates, and a ban on repeated SSH failures:

```bash
sudo apt update && sudo apt install -y unattended-upgrades fail2ban
sudo dpkg-reconfigure -plow unattended-upgrades
sudo systemctl enable --now fail2ban
```

Swap, so an image build cannot take the machine down:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Keep the server clock in UTC — dates are stored UTC and displayed Asia/Dhaka
by the application (§9), so the server's own timezone should stay out of it:

```bash
sudo timedatectl set-timezone UTC
```

---

## 4. Install Docker

From Docker's own repository, not Ubuntu's — Ubuntu ships an old fork.

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo tee /etc/apt/keyrings/docker.asc > /dev/null
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy
```

Log out and back in for the group to apply, then check: `docker run --rm hello-world`.

---

## 5. DNS and the Cloudflare token

Two A records, both pointing at the VPS IP, both **DNS only** (grey cloud —
Caddy terminates TLS itself, and proxying on top causes redirect loops):

| Type | Name | Content |
|---|---|---|
| A | `@` | `YOUR_SERVER_IP` |
| A | `*` | `YOUR_SERVER_IP` |

The `*` record is the one that makes a new workspace work the moment its row
exists, with no DNS change per client.

Then create an API token at **My Profile → API Tokens → Create Token**, using
the *Edit zone DNS* template, scoped to **this zone only**. Caddy needs it to
answer the DNS-01 challenge — the only challenge type Let's Encrypt accepts for
a wildcard certificate.

---

## 6. Get the code and configure

```bash
sudo mkdir -p /srv && sudo chown deploy:deploy /srv
cd /srv
git clone https://github.com/Smomi99/tripleslogisticsoftware.git ff-erp
cd ff-erp

cp .env.production.example .env.production
chmod 600 .env.production
```

Generate four secrets, each different:

```bash
for n in POSTGRES_PASSWORD FF_APP_PASSWORD JWT_ACCESS_SECRET JWT_REFRESH_SECRET; do
  echo "$n=\"$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-48)\""
done
```

Paste those into `.env.production`, then fill in `APP_DOMAIN`, `ACME_EMAIL` and
`CLOUDFLARE_API_TOKEN`. **Leave `DEFAULT_TENANT_SLUG` empty** — that is what
turns on subdomain routing, and it is the reason you bought a server.

---

## 6b. Object storage — Cloudflare R2

Uploaded files are agency agreements and employee service contracts. They are
low in volume and high in consequence: nobody notices one is missing until it is
needed in a dispute.

They do **not** live on the server. A Docker volume survives a restart, but not
a rebuild onto a new host, and it is not in the nightly database dump — so a
restore would bring back every row and none of the paper behind it. R2 is a
separate durable store with no egress charge, and the API speaks plain S3 to it.

### Create the bucket

1. Cloudflare dashboard → **R2** → **Create bucket**, e.g. `ff-erp-files`.
   Leave it **private**. The API streams files to signed-in staff, so the bucket
   never needs public access and should never be given any.
2. **Manage R2 API Tokens** → **Create API token**:
   - Permission: **Object Read & Write**
   - Specify bucket: the one you just made, and only that one
   - No TTL, or one you will remember to rotate
3. Copy the **Access Key ID**, the **Secret Access Key** and the
   **S3 endpoint** — `https://<account-id>.r2.cloudflarestorage.com`. The secret
   is shown once.

### Configure

In `.env.production`:

```
STORAGE_DRIVER="s3"
S3_BUCKET="ff-erp-files"
S3_REGION="auto"
S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
S3_ACCESS_KEY_ID="..."
S3_SECRET_ACCESS_KEY="..."
```

`S3_REGION` is the literal string `auto`. R2 has one region and does not accept
`us-east-1` or anything else; the error when you get this wrong reads like a
credentials problem, which sends you looking in the wrong place.

### Prove it works before you need it

```bash
$COMPOSE run --rm tools pnpm --filter @ff/api storage:check
```

This writes a small object, reads it back, compares the bytes and deletes it —
the same code path an upload takes. A `HeadBucket` would not do: it passes with
a read-only token that cannot store anything.

Run it as part of every deploy. A bucket is the one dependency whose
misconfiguration is invisible until an operator attaches a file, which may be
weeks later.

### If files are already on the server

Only relevant if you ran with `STORAGE_DRIVER=local` first. The keys are
identical in both drivers — the database stores a key, never a path — so
copying the objects across is the whole migration:

```bash
docker run --rm -v ff-erp_uploads:/data -e RCLONE_CONFIG_R2_TYPE=s3   -e RCLONE_CONFIG_R2_PROVIDER=Cloudflare   -e RCLONE_CONFIG_R2_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"   -e RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"   -e RCLONE_CONFIG_R2_ENDPOINT="$S3_ENDPOINT"   rclone/rclone copy /data R2:ff-erp-files --progress
```

Then flip `STORAGE_DRIVER` to `s3`, restart, and run `storage:check`. Keep the
volume until you have opened a few files through the UI.

### Working on uploads locally

R2 has no emulator, and pointing a laptop at the real bucket puts test files
beside real agreements. `docker-compose.yml` runs MinIO for this — the same S3
API, on your machine:

```bash
docker compose --profile storage up -d minio minio-init
```

Then in `.env`:

```
STORAGE_DRIVER="s3"
S3_BUCKET="ff-erp-files"
S3_REGION="auto"
S3_ENDPOINT="http://localhost:9000"
S3_FORCE_PATH_STYLE="true"
S3_ACCESS_KEY_ID="ff_minio"
S3_SECRET_ACCESS_KEY="ff_minio_dev"
```

`S3_FORCE_PATH_STYLE` is for MinIO only. R2 and AWS address buckets as a
subdomain and do not want it.

---

## 7. First boot — order matters

The API refuses to start until `ff_app` can log in, and `ff_app` does not exist
until the migrations have run. So bring the database up alone first.

```bash
cd /srv/ff-erp
export COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"

$COMPOSE build                 # 10–30 minutes the first time, mostly npm downloads
$COMPOSE up -d postgres
```

**Migrations.** These create the tables, the RLS policies, the 28 cross-tenant
parent triggers, and `ff_app` as a `NOLOGIN` role:

```bash
$COMPOSE run --rm tools pnpm db:deploy
```

**Give `ff_app` its password.** It must match `FF_APP_PASSWORD` exactly:

```bash
set -a; source .env.production; set +a
$COMPOSE exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "ALTER ROLE ff_app LOGIN PASSWORD '$FF_APP_PASSWORD';"
```

`scripts/dev-db-app-role.sql` is the local-only version of this step, with a
well-known password. Never run that file here.

**Seed** the permission registry, the shared lookup values, the first workspace
and its superadmin. `SEED_TENANT_SLUG` becomes the subdomain:

```bash
$COMPOSE run --rm \
  -e SEED_DEV_TENANT=true \
  -e SEED_TENANT_SLUG=acme \
  -e SEED_TENANT_NAME="Acme Freight Ltd" \
  -e SEED_SUPERADMIN_PASSWORD='choose-a-real-one' \
  tools pnpm db:seed
```

**Start everything:**

```bash
$COMPOSE up -d
$COMPOSE ps
```

Caddy will take a minute or two to get the wildcard certificate on first run.
Watch it: `$COMPOSE logs -f caddy`.

Then open `https://acme.yourdomain.com/login` and sign in as `superadmin`.

---

## 8. Adding another workspace

Each workspace is one row plus its own superadmin, and the wildcard DNS and
certificate already cover it:

```bash
$COMPOSE run --rm \
  -e SEED_DEV_TENANT=true \
  -e SEED_TENANT_SLUG=globex \
  -e SEED_TENANT_NAME="Globex Logistics" \
  -e SEED_SUPERADMIN_PASSWORD='...' \
  tools pnpm db:seed
```

It is idempotent: rerunning it for an existing slug re-asserts the superadmin's
password and role and changes nothing else.

**This is the whole onboarding story today.** §7A rule 6 wants tenant creation
to be one transactional function with an invite email, and §7B wants a platform
console to do it from a browser. Neither is built, so adding a client is an SSH
session. Fine for the first few; not fine at twenty.

---

## 9. Backups, and proving they work

`deploy/backup.sh` dumps the database and tars the uploads. Both, together —
the database stores only file *keys* (§2), so a database restored without its
files points at agreements that are not there.

```bash
chmod +x deploy/backup.sh
crontab -e
```

```cron
15 2 * * * /srv/ff-erp/deploy/backup.sh >> /var/log/ff-erp-backup.log 2>&1
```

Set `OFFSITE_REMOTE` in `.env.production` and install `rclone` to get copies
off the box. A backup on the same disk survives a bad migration; it does not
survive the VPS being deleted.

### Do the restore drill once, now

An untested backup is a hope. On a *scratch* machine or a second stack:

```bash
$COMPOSE up -d postgres
$COMPOSE exec -T postgres createdb -U "$POSTGRES_USER" restore_test
cat /var/backups/ff-erp/db-XXXX.dump \
  | $COMPOSE exec -T postgres pg_restore -U "$POSTGRES_USER" -d restore_test --no-owner
$COMPOSE exec -T postgres psql -U "$POSTGRES_USER" -d restore_test \
  -c "SELECT count(*) FROM inquiry;"
```

If that number looks right, you have backups. If you have not run it, you do
not know.

---

## 10. The nightly rate-expiry job

`rates:expire` moves lapsed purchase rates to `EXPIRED`. Until it runs, the
price list keeps offering lanes whose validity has passed — quotable rates that
should not be quotable. It is a command, and nothing invokes it on its own:

```cron
30 0 * * * cd /srv/ff-erp && docker compose -f docker-compose.prod.yml --env-file .env.production run --rm tools pnpm --filter @ff/api rates:expire >> /var/log/ff-erp-rates.log 2>&1
```

---

## 11. Day-to-day operations

```bash
$COMPOSE ps                       # what is running
$COMPOSE logs -f api              # follow the API
$COMPOSE logs -f caddy            # certificate problems live here
$COMPOSE restart api
```

**A shell on the database**, on the server:

```bash
$COMPOSE exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

**From your laptop**, without exposing anything. Postgres is bound to the
server's loopback only, so an SSH tunnel is the way in:

```bash
ssh -N -L 5433:localhost:5432 deploy@YOUR_SERVER_IP
```

Leave that running, and `localhost:5433` on your machine is the production
database. Prisma Studio, DBeaver and psql all work against it:

```bash
psql "postgresql://ff_erp:PASSWORD@localhost:5433/ff_erp"
```

Local port 5433, not 5432, so you cannot mistake it for your development
database — which is exactly the mistake worth engineering against.

> **Never add a plain `- '5432:5432'` to the compose file.** Docker writes its
> own iptables rules *ahead* of ufw's, so a published port is reachable from
> the internet even though `ufw status` says it is blocked. The
> `127.0.0.1:` prefix is what keeps it private.

**Disk.** Uploads and Postgres both live in Docker volumes:

```bash
docker system df
docker volume ls | grep ff-erp
```

---

## 12. Deploying a new version

```bash
cd /srv/ff-erp
git pull
$COMPOSE run --rm tools pnpm db:deploy    # migrations first, always
$COMPOSE run --rm tools pnpm db:seed      # lookup values the release adds
$COMPOSE up -d --build
$COMPOSE run --rm tools pnpm exec tsx apps/api/src/scripts/doctor.mts
```

Migrations before the new containers, because a new image may expect a column
the old schema does not have. `prisma migrate deploy` never resets and never
prompts — it applies pending migrations and stops.

The seed carries lookup values, not business data. It only creates rows it has
not seen and refreshes the product's own default email templates; it never
touches a workspace's records. Skipping it does not break the site, but a
dropdown a release adds will be empty and nobody will know why.

**Run the doctor last, and read it.** It compares every table and column the
deployed code expects against the database and names anything missing:

```
=== does the database have what the code selects? ===
  FAIL  column missing: customer.notes
  FAIL  column missing: customer.salesman_id
```

That is what a skipped migration looks like from the outside — the browser only
ever shows 500, because the API cannot select a column that is not there. The
doctor is read-only and safe to run against production at any time, so run it
whenever a screen starts failing and you are not sure why.

If the server is too small to build (§1), build on your laptop and push:

```bash
docker build -f apps/api/Dockerfile -t ghcr.io/you/ff-erp-api:$(git rev-parse --short HEAD) .
docker push ghcr.io/you/ff-erp-api:...
```

…then replace the `build:` blocks in `docker-compose.prod.yml` with `image:`.

---

## 13. When it does not work

**`api` restarts in a loop.** Almost always the `ff_app` password. The role's
password in Postgres and `FF_APP_PASSWORD` in `.env.production` must match
exactly; re-run the `ALTER ROLE` in §7 with the value from the file.
`$COMPOSE logs api` will show the connection error.

**Caddy never gets a certificate.** `$COMPOSE logs caddy`. In order of
likelihood: the Cloudflare token lacks *Zone:DNS:Edit* on this zone; the `*`
A record does not exist yet or has not propagated (`dig +short a.yourdomain.com`
should return the VPS IP); or the records are proxied (orange cloud) when they
must be DNS-only.

**Every subdomain shows the same workspace, or none.** `DEFAULT_TENANT_SLUG` is
set when it should be empty — it deliberately overrides the Host header. Clear
it, then `$COMPOSE up -d --build` (the web image bakes it in at build time).

**The build is killed partway through.** Out of memory. Add swap (§3), or build
the images elsewhere (§12).

**`login` works, then everything 401s a few minutes later.** The refresh cookie
is not coming back. Check that the app and the API are on the *same* hostname —
that is what §1 is about — and that you reached the site over `https`, since
the cookie is `Secure` in production.

---

## 14. Before real client data lands

- [ ] `PasswordAuthentication no`, and key login tested from a second terminal
- [ ] `ufw status` shows only OpenSSH, 80, 443
- [ ] `.env.production` is `chmod 600` and has never been committed
- [ ] `DATABASE_URL_APP` uses **ff_app**, not the owner role
- [ ] The seeded superadmin password is not the one from `.env.example`
- [ ] Backups are running **and** you have completed the restore drill (§9)
- [ ] `OFFSITE_REMOTE` is set — backups exist somewhere other than this VPS
- [ ] The rate-expiry cron is installed (§10)
- [ ] `https://` works and `http://` redirects to it

---

## 15. What is still unbuilt

Not hosting problems — gaps in the product that hosting makes visible:

- **`audit_log` is empty and nothing writes to it.** §4 rule 7 requires a
  Prisma middleware recording every create, update and deactivate; the table
  exists, the middleware does not. There is currently no way to answer "who
  changed this, and what was it before?"
- **Tenant onboarding is a shell command** (§8), not the zero-touch function
  §7A rule 6 asks for.
- **Subscriptions and plan gating (§7B) are deferred.** Every workspace has
  every feature, and nothing enforces seat or volume limits.
- **Suspension is not enforced.** §7B makes `SUSPENDED` read-only plus export;
  sign-in already allows it deliberately, but write routes do not yet check.

None of these block a first client. All of them get harder to add the more data
accumulates.

---

## Appendix — reading the emails on your own machine

The product sends four kinds of message: an inquiry to an agent, a rate request
to the price team, a portal invite, and a password reset. None of them can be
checked by reading the code, because what matters is the wording, the link, and
whether it arrives at all.

`docker-compose.yml` runs **Mailpit** for this. It speaks SMTP and delivers
nothing — every message is caught and shown in a web inbox instead.

```bash
docker compose up -d mailpit          # SMTP on 1025, inbox on 8025
```

Then in `.env`:

```
SMTP_HOST="localhost"
SMTP_PORT=1025
SMTP_SECURE=false
MAIL_FROM="pricing@localhost.test"
APP_URL="http://localhost:3000"
```

No `SMTP_USER` or `SMTP_PASS`: Mailpit wants none, and the API treats
credentials as optional so a catcher can be pointed at. Restart the API and open
**http://localhost:8025**.

Nothing leaves the machine, which is the point — you can send yourself fifty
invites without an agent ever seeing one.

### Making each message appear

| Message | How to trigger it |
|---|---|
| Portal invite | CRM → Agent → open one → **Portal access** → invite a contact that has an email address |
| Password reset | The portal's **Forgotten your password?**, or the agent's own Account page |
| Rate needed | Save an **Outbound** inquiry on a lane with no live purchased rate |
| Quotation received | An agent submits a quote in the portal (needs the price team address set in Settings → Notifications) |

The invite and reset links in the caught mail are real. Click one and it works.

### When nothing arrives

`SMTP_HOST` unset is a deliberate no-op, not a failure — the API logs
`mail skipped: SMTP is not configured` and carries on, because a notification
must never fail the thing it is about. Look for that line first. `mail skipped:
no recipients` means the message was built but nobody was addressed: an agent
contact with no email, or an empty price team address in Settings →
Notifications.

### Sending for real

Swap in the Zoho block from `.env.example`. `SMTP_PASS` is an **app-specific
password**, never the mailbox password — it can be revoked on its own, and it is
the one secret in that file another system also holds.
