# syntax=docker/dockerfile:1
#
# The API image. Build from the REPO ROOT, not from apps/api:
#   docker build -f apps/api/Dockerfile .
#
# Four stages so the runtime image carries no compiler, no dev dependency and
# no source: base (pnpm), deps (the lockfile only, so it caches), build, and a
# runtime that installs production dependencies from scratch.
#
# Dependencies are installed INSIDE the image rather than copied in, because
# @node-rs/argon2 is a native module — a node_modules tree built on a developer
# machine cannot run here.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# pnpm's defaults assume a fast link: 16 parallel fetches and a 60s timeout.
# On a modest connection that starves each download until tarballs time out and
# the whole install fails near the end. Fewer parallel fetches, more patience.
ENV npm_config_network_concurrency=8
ENV npm_config_fetch_retries=5
ENV npm_config_fetch_timeout=600000
RUN corepack enable
WORKDIR /app

# --------------------------------------------------------------------------
# deps — every workspace manifest, nothing else. This layer is rebuilt only
# when a package.json or the lockfile changes, not when source does.
# --------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --------------------------------------------------------------------------
# build — generate the Prisma client (gitignored, so it must be made here)
# and bundle the server. tsup inlines @ff/shared and the generated client;
# third-party dependencies stay external and are installed below.
# --------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm db:generate && pnpm --filter @ff/api build

# --------------------------------------------------------------------------
# runtime
# --------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# The manifests come back because pnpm needs the whole workspace to honour the
# lockfile — and because config/env locates the repo root by walking up to
# pnpm-workspace.yaml. Without that marker a relative STORAGE_LOCAL_PATH
# cannot be resolved and the server refuses to start.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# --filter @ff/api... narrows this to the API and its workspace dependencies.
# Without it the runtime image also installs Next, React, Tailwind and sharp —
# several hundred megabytes the API never loads.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @ff/api...

COPY --from=build /app/apps/api/dist ./apps/api/dist

# Migrations and seeding do NOT run from this image. They need the Prisma CLI,
# tsx and the schema — a toolchain that has no business sitting in a container
# exposed to the internet. The `build` stage already has all of it, so
# docker-compose.prod.yml runs those from there as one-off containers under the
# `tools` profile. Same source, same commit, no drift.

# Uploads land here; docker-compose mounts a named volume over it. §2 keeps
# only the key in the database, so this directory IS the file store — it is
# the one piece of state besides Postgres.
RUN mkdir -p /app/storage && chown -R node:node /app/storage
ENV STORAGE_LOCAL_PATH=/app/storage

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
