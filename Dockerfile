# syntax=docker/dockerfile:1
# bookworm required for @roamhq/wrtc (glibc; not alpine)

ARG NODE_VERSION=24.18.0

# ── base ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm AS base
RUN corepack enable
WORKDIR /app

# ── full deps (build-time: includes devDependencies) ─────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-zapo-rest,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── production deps only (runtime) ───────────────────────────────────────────
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-zapo-rest,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ── build API ────────────────────────────────────────────────────────────────
FROM deps AS build-api
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build:api \
  && find dist -name '*.map' -delete

# ── build dashboard ──────────────────────────────────────────────────────────
FROM deps AS build-dash
COPY dashboard/package.json dashboard/pnpm-lock.yaml ./dashboard/
WORKDIR /app/dashboard
RUN --mount=type=cache,id=pnpm-zapo-rest,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY dashboard/ ./
RUN pnpm build

# ── build docs guide SPA ─────────────────────────────────────────────────────
FROM deps AS build-docs
COPY docs-site/package.json docs-site/package-lock.json* docs-site/pnpm-lock.yaml* ./docs-site/
WORKDIR /app/docs-site
RUN --mount=type=cache,id=pnpm-zapo-rest,target=/root/.local/share/pnpm/store \
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    else npm install; fi
COPY docs-site/ ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm build; else npm run build; fi

# ── runner ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runner

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    dumb-init \
    ffmpeg \
    ca-certificates \
    wget \
  && rm -rf /var/lib/apt/lists/* \
  && apt-get clean

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    MEDIA_TMP_DIR=/tmp/zapo-rest-media \
    # Avoid writing npm junk; no telemetry
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    # Slightly safer defaults
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app

RUN groupadd --system --gid 10001 zapo \
  && useradd --system --uid 10001 --gid zapo --home-dir /app --shell /usr/sbin/nologin zapo \
  && mkdir -p /tmp/zapo-rest-media \
  && chown -R zapo:zapo /app /tmp/zapo-rest-media

# Production node_modules only (no typescript/vitest/biome toolchain)
COPY --from=prod-deps --chown=zapo:zapo /app/node_modules ./node_modules
COPY --from=prod-deps --chown=zapo:zapo /app/package.json ./package.json

COPY --from=build-api --chown=zapo:zapo /app/dist ./dist
COPY --from=build-api --chown=zapo:zapo /app/src/db/schema.sql ./src/db/schema.sql
COPY --from=build-dash --chown=zapo:zapo /app/dashboard/dist ./dashboard/dist
COPY --from=build-docs --chown=zapo:zapo /app/docs-site/dist ./docs-site/dist

USER zapo
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# dumb-init reaps zombies (ffmpeg/wrtc child processes)
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
