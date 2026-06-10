# syntax=docker/dockerfile:1
# Build context MUST be packages/backend/ (the service tsconfig extends ../tsconfig.json).
# signing-layer HOLDS THE VAULT KEY — this image is the trust-sensitive one. It also uses
# better-sqlite3 (native), so the build stage carries a toolchain.
#
# This service is intentionally self-contained (no workspace deps) so the whole container
# can be lifted onto a dedicated, isolated host later with no code change — only move
# env/signing-layer.env and the signing_data volume.

FROM node:22-bookworm AS build
WORKDIR /app
RUN corepack enable && apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY tsconfig.json ./tsconfig.json
COPY signing-layer/package.json ./signing-layer/package.json
WORKDIR /app/signing-layer
# pnpm 11 blocks native build scripts (ERR_PNPM_IGNORED_BUILDS) unless explicitly allowed.
# onlyBuiltDependencies (pnpm-workspace.yaml / package.json) is NOT honored in this standalone
# context; the install-time flag is. Runs dep build scripts (better-sqlite3) — same trust
# level as a local dev install of these same deps.
RUN pnpm install --no-frozen-lockfile --config.dangerouslyAllowAllBuilds=true
COPY signing-layer/tsconfig.json ./tsconfig.json
COPY signing-layer/src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    SETTLEMENT_DB_PATH=/data/settlement.db
WORKDIR /app/signing-layer
RUN mkdir -p /data
COPY --from=build /app/signing-layer/node_modules ./node_modules
COPY --from=build /app/signing-layer/dist ./dist
COPY --from=build /app/signing-layer/package.json ./package.json
EXPOSE 3004
# No /health route — the root "/" handler is the liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3004/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/index.js"]
