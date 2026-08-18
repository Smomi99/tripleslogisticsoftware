# syntax=docker/dockerfile:1
#
# The web image. Build from the REPO ROOT, not from apps/web:
#   docker build -f apps/web/Dockerfile .
#
# Runs `next start` against a real production install rather than Next's
# `output: 'standalone'`. See the comment in next.config.ts: standalone
# under-traces pnpm's node_modules and produced an image that died on startup
# with MODULE_NOT_FOUND while working perfectly on a developer machine.
#
# NEXT_PUBLIC_* values are inlined into the browser bundle at BUILD time, not
# read at boot. Passing them as build args is not a style choice: setting them
# in docker-compose's `environment` would leave the client bundle still holding
# whatever was baked in, which for NEXT_PUBLIC_API_URL means every browser
# request going to http://localhost:4000. The default below is the empty
# string, which makes API calls same-origin — Caddy routes /api to the API
# container, so the browser only ever talks to one host and the SameSite=Lax
# refresh cookie keeps working.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# See apps/api/Dockerfile: pnpm's defaults assume a fast link and fail near the
# end of a large install on a modest one.
ENV npm_config_network_concurrency=8
ENV npm_config_fetch_retries=5
ENV npm_config_fetch_timeout=600000
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# Set ONLY on a deployment without wildcard DNS, and then it must match the
# API's DEFAULT_TENANT_SLUG. With wildcard subdomains, leave it unset so
# proxy.ts resolves the workspace from the host (§7A rule 5).
ARG NEXT_PUBLIC_TENANT_SLUG=""
ENV NEXT_PUBLIC_TENANT_SLUG=$NEXT_PUBLIC_TENANT_SLUG
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
# The build cache is 260 MB and is only useful to a rebuild — and rebuilds
# happen in this stage, never in the shipped image.
RUN pnpm --filter @ff/web build && rm -rf apps/web/.next/cache

FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Production dependencies for the web app only. @ff/shared is a workspace
# dependency, so `...` pulls it in; the API's are left out entirely.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @ff/web...

# @ff/shared ships TypeScript source and is compiled into .next at build time,
# but next.config.ts still names it in transpilePackages, so the package must
# exist for the config to load.
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY apps/web/next.config.ts ./apps/web/

WORKDIR /app/apps/web
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# pnpm links a workspace package's binaries into ITS OWN node_modules/.bin,
# not the root one — /app/node_modules/.bin/next does not exist.
CMD ["./node_modules/.bin/next", "start"]
