# Build context MUST be packages/backend/ (the service tsconfig extends ../tsconfig.json).
#   docker build -f proof-relay/Dockerfile -t polyshield-proof-relay packages/backend
# (docker compose does this for you.)

FROM node:22-bookworm AS build
WORKDIR /app
# python3/make/g++: native toolchain for better-sqlite3 (the merkle-cache DB), used only if a prebuilt
# binary isn't available for this platform (prebuild-install fetches one when it is).
RUN corepack enable && apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# Shared parent tsconfig that every backend service extends.
COPY tsconfig.json ./tsconfig.json
# Manifest first for layer caching.
COPY proof-relay/package.json ./proof-relay/package.json
WORKDIR /app/proof-relay
# pnpm 11 blocks native build/postinstall scripts unless explicitly allowed (better-sqlite3 needs it).
RUN pnpm install --no-frozen-lockfile --config.dangerouslyAllowAllBuilds=true
COPY proof-relay/tsconfig.json ./tsconfig.json
COPY proof-relay/src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    PROOF_RELAY_PORT=3002
WORKDIR /app/proof-relay
COPY --from=build /app/proof-relay/node_modules ./node_modules
COPY --from=build /app/proof-relay/dist ./dist
COPY --from=build /app/proof-relay/package.json ./package.json
EXPOSE 3002
# BIND_HOST=0.0.0.0 is safe: the port is NOT published to the host (see compose),
# so it is reachable only over the private compose network.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3002/health',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/index.js"]
