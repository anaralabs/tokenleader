# syntax=docker/dockerfile:1
# Server runtime pin. Daemon binaries are built elsewhere on Bun 1.1.38.
ARG BUN_VERSION=1.3.14

# ---- deps -------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# ---- web --------------------------------------------------------------------
# SPA build. When web/ is absent this stage emits an empty dist/ so the
# release COPY below always works.
FROM oven/bun:${BUN_VERSION} AS web
WORKDIR /app
COPY . .
RUN if [ -d web ]; then \
      cd web && bun install --frozen-lockfile && bun run build; \
    else \
      mkdir -p web/dist; \
    fi

# ---- release ------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS release
LABEL org.opencontainers.image.source="https://github.com/anaralabs/tokenleader" \
      org.opencontainers.image.description="Self-hosted AI token-usage leaderboard" \
      org.opencontainers.image.licenses="MIT"
# Default EMPTY on purpose: a truthy default (e.g. v0.0.0-dev) would override the v${pkg.version}
# fallback on every build that passes no build-arg (e.g. PaaS repo-sourced deploys), yielding a
# permanent false "update available" pill. CI passes the real tag.
ARG SERVER_VERSION=
ENV TOKENLEADER_SERVER_VERSION=$SERVER_VERSION

WORKDIR /app
# sqlite3 CLI: required by the documented .backup advice and the entrypoint's staged-import restore.
# util-linux: setpriv for the entrypoint privilege drop (explicit; never rely on the base
# image vintage shipping it).
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 util-linux \
    && rm -rf /var/lib/apt/lists/*

# Litestream: optional continuous SQLite replication to S3-compatible storage.
# Baked into every image; ACTIVE only when LITESTREAM_REPLICA_URL is set (see
# docker-entrypoint.sh) — an unconfigured deploy pays ~10MB of image, nothing else.
ARG LITESTREAM_VERSION=0.3.13
ARG TARGETARCH
ADD https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-${TARGETARCH}.tar.gz /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream \
    && rm /tmp/litestream.tar.gz \
    && litestream version
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY --from=web /app/web/dist ./web/dist
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=8787 \
    TOKENLEADER_DATA_DIR=/data

# Named volumes inherit ownership on first use; bind mounts / PaaS volumes fixed by the entrypoint.
# No VOLUME instruction: Railway's builder rejects it, and compose/fly declare the
# /data mount explicitly. Mount your volume at /data (TOKENLEADER_DATA_DIR).
RUN mkdir -p /data && chown -R bun:bun /data \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8787

# debian-slim has no curl; bun itself is the probe. /health is constant-time.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "src/server/main.ts"]
