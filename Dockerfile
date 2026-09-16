# syntax=docker/dockerfile:1

# ---- deps: install node_modules from the lockfile ----
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- builder: run the React Router / Vite build ----
FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun --bun run build

# ---- runtime ----
FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/time-tracker.db

# tzdata provides /usr/share/zoneinfo. Without it TZ silently falls back to UTC
# and the setting becomes a no-op — which in this app means evening work gets
# booked onto the following day. Compose pins TZ authoritatively; this default
# just makes `docker run` and local debugging behave the same way.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tzdata \
  && rm -rf /var/lib/apt/lists/*
ENV TZ=UTC

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./package.json
# src/ holds runtime-only server modules (SQLite, accounting backends) that
# Vite externalizes from the SSR bundle, so they must exist at runtime.
COPY --from=builder /app/src ./src

VOLUME ["/data"]
EXPOSE 3000

CMD ["bun", "run", "start"]
