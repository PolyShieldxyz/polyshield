# Build context = packages/frontend. The app has server-side API routes, so it runs as a
# Node server (`next start`), NOT a static export.
#
# IMPORTANT: NEXT_PUBLIC_* are inlined into the browser bundle at BUILD time, so they must
# be supplied as build args (docker compose passes them from deploy/.env). Server-only
# secrets (OPERATOR_API_TOKEN, backend URLs) are injected at RUN time via env (see compose).

FROM node:22-bookworm AS build
WORKDIR /app
# Raise Node's heap ceiling for install + build. The build context is only
# packages/frontend, so the monorepo pnpm-lock.yaml isn't available here and pnpm must do
# a full from-scratch dependency resolution (memory-heavy). With the markdown/remark/katex
# stack the resolution graph + the Next build exceed Node's default ~2 GB heap and V8 aborts
# (exit 134). 4 GB clears both phases; this host has swap headroom to back it.
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN corepack enable
COPY package.json ./
# pnpm 11 blocks native build scripts (ERR_PNPM_IGNORED_BUILDS) unless explicitly allowed.
# onlyBuiltDependencies is NOT honored in this standalone context; the install-time flag is.
# Runs dep build scripts (sharp/esbuild/unrs-resolver) — same trust level as local dev install.
RUN pnpm install --no-frozen-lockfile --config.dangerouslyAllowAllBuilds=true
COPY . .

ARG NEXT_PUBLIC_CHAIN_ID
ARG NEXT_PUBLIC_CHAIN_RPC
ARG NEXT_PUBLIC_POLYGON_RPC
ARG NEXT_PUBLIC_VAULT_ADDRESS
ARG NEXT_PUBLIC_USDC_ADDRESS
ARG NEXT_PUBLIC_WC_PROJECT_ID
ARG NEXT_PUBLIC_DEV_MODE=false
ARG NEXT_PUBLIC_VAULT_DEPLOY_BLOCK
ENV NEXT_PUBLIC_CHAIN_ID=$NEXT_PUBLIC_CHAIN_ID \
    NEXT_PUBLIC_CHAIN_RPC=$NEXT_PUBLIC_CHAIN_RPC \
    NEXT_PUBLIC_POLYGON_RPC=$NEXT_PUBLIC_POLYGON_RPC \
    NEXT_PUBLIC_VAULT_ADDRESS=$NEXT_PUBLIC_VAULT_ADDRESS \
    NEXT_PUBLIC_USDC_ADDRESS=$NEXT_PUBLIC_USDC_ADDRESS \
    NEXT_PUBLIC_WC_PROJECT_ID=$NEXT_PUBLIC_WC_PROJECT_ID \
    NEXT_PUBLIC_DEV_MODE=$NEXT_PUBLIC_DEV_MODE \
    NEXT_PUBLIC_VAULT_DEPLOY_BLOCK=$NEXT_PUBLIC_VAULT_DEPLOY_BLOCK \
    NODE_ENV=production
# config.ts throws here if a required NEXT_PUBLIC_* is missing (strict prod validation) —
# that is intended: a misconfigured build fails fast instead of shipping a broken bundle.
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"
# next start binds 0.0.0.0:3000 inside the container; not published to the host (Caddy fronts it).
CMD ["pnpm", "start"]
