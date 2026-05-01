# syntax=docker/dockerfile:1.6
#
# ai-job-searcher cron container.
#
# Runs supercronic + a Node 20 runtime. The cron schedule lives in
# cron/check.cron and triggers `node engine/cli.js check --profile <id> --auto`
# for each profile.
#
# State is read/written under /data (see fly.toml volume mount). The
# AI_JOB_SEARCHER_DATA_DIR env var tells the engine to look there for
# profiles/<id>/applications.tsv, .gmail-state/, etc.
#
# Build:   docker build -t ai-job-searcher-cron .
# Run:     docker run --rm -e JARED_NOTION_TOKEN=... ... ai-job-searcher-cron
# Deploy:  fly deploy   (uses fly.toml)

# -------- Stage 1: install prod dependencies --------
FROM node:20-alpine AS deps
WORKDIR /app

# Only need package files for npm ci. This keeps the layer cache hot when
# source files change but deps don't.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# -------- Stage 2: runtime --------
FROM node:20-alpine AS runtime

# Pin supercronic version. Bump only after verifying release on
# https://github.com/aptible/supercronic/releases — confirm the linux-amd64
# / linux-arm64 binaries exist for the chosen tag.
# TODO(security S2): add sha256 verification step (download .sha256 + sha256sum -c).
ARG SUPERCRONIC_VERSION=v0.2.29

# Install supercronic + tzdata (so cron schedule honors America/Los_Angeles).
RUN apk add --no-cache curl tzdata ca-certificates \
    && ARCH=$(uname -m) \
    && if [ "$ARCH" = "x86_64" ]; then \
         SUPERCRONIC_ARCH=amd64; \
       elif [ "$ARCH" = "aarch64" ]; then \
         SUPERCRONIC_ARCH=arm64; \
       else \
         echo "unsupported arch: $ARCH"; exit 1; \
       fi \
    && URL="https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${SUPERCRONIC_ARCH}" \
    && curl -fsSLo /usr/local/bin/supercronic "$URL" \
    && chmod +x /usr/local/bin/supercronic \
    && apk del curl

# Run as a non-root user. supercronic doesn't need root.
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Bring in deps first (cached separately from source).
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app package.json package-lock.json ./

# Then source. .dockerignore excludes profiles/, .env, .gmail-tokens/, etc.
# Only ship what `check --auto` actually reads at runtime: engine code +
# cron schedule. Skills / scripts / data / rfc / docs are dev-only.
COPY --chown=app:app engine ./engine
COPY --chown=app:app cron ./cron

# /data is the persistent volume mount. Cron + the engine read/write here via
# AI_JOB_SEARCHER_DATA_DIR=/data. The volume itself is created by
# `fly volumes create` (see fly.toml + scripts/deploy_fly.sh).
RUN mkdir -p /data && chown -R app:app /data /app

USER app

# America/Los_Angeles -> 8am PST/PDT trigger lines up with cron schedule
# `0 8 * * *` in cron/check.cron.
ENV TZ=America/Los_Angeles
ENV AI_JOB_SEARCHER_DATA_DIR=/data
ENV NODE_ENV=production

# supercronic runs in foreground; logs to stderr (fly logs picks them up).
# -quiet suppresses heartbeat-style messages, keeps real output.
CMD ["supercronic", "-quiet", "/app/cron/check.cron"]
