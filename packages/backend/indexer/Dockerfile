# syntax=docker/dockerfile:1
# Build context MUST be packages/backend/ (the service tsconfig extends ../tsconfig.json).
# indexer uses better-sqlite3 (native) — the build stage carries a toolchain in case no
# prebuilt binary is available for this platform/Node ABI.

FROM node:22-bookworm AS build
WORKDIR /app
RUN corepack enable && apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY tsconfig.json ./tsconfig.json
COPY indexer/package.json ./indexer/package.json
WORKDIR /app/indexer
# pnpm 11 blocks native build scripts (ERR_PNPM_IGNORED_BUILDS) unless explicitly allowed.
# onlyBuiltDependencies (pnpm-workspace.yaml / package.json) is NOT honored in this standalone
# context; the install-time flag is. Runs dep build scripts (better-sqlite3) — same trust
# level as a local dev install of these same deps.
RUN pnpm install --no-frozen-lockfile --config.dangerouslyAllowAllBuilds=true
COPY indexer/tsconfig.json ./tsconfig.json
COPY indexer/src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    INDEXER_PORT=3003 \
    INDEXER_DB_PATH=/data/polyshield.db
WORKDIR /app/indexer
# Persisted SQLite lives on a mounted volume at /data (see compose).
RUN mkdir -p /data
COPY --from=build /app/indexer/node_modules ./node_modules
COPY --from=build /app/indexer/dist ./dist
COPY --from=build /app/indexer/package.json ./package.json
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3003/health',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/index.js"]
