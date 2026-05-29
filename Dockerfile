FROM node:22-slim AS base

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ── Install dependencies ──
FROM base AS deps

COPY package.json pnpm-workspace.yaml ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/

RUN pnpm install --no-frozen-lockfile

# ── Build API server ──
FROM deps AS build-api

COPY apps/gateway/ apps/gateway/

RUN cd apps/gateway && pnpm run build

# ── Build dashboard ──
FROM deps AS build-dashboard

COPY apps/dashboard/ apps/dashboard/

RUN cd apps/dashboard && pnpm run build

# ── Production ──
FROM base AS production

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/gateway/node_modules ./apps/gateway/node_modules
COPY --from=build-api /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=build-api /app/apps/gateway/package.json ./apps/gateway/
COPY --from=build-dashboard /app/apps/dashboard/dist/public ./apps/dashboard/dist/public

WORKDIR /app/apps/gateway

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "--enable-source-maps", "dist/index.mjs"]