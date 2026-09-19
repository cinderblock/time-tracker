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
# The server build already contains src/; the operator commands
# (`bun run admin-link`) run from source, so it's copied too. server.ts is the
# production server (Express behind the reverse proxy); Bun runs it as is.
COPY --from=builder /app/src ./src
COPY --from=builder /app/server.ts ./server.ts

VOLUME ["/data"]
EXPOSE 3000

# Any answer below 500 means the server is up (signed out, / redirects). The
# first request also starts the app — migrations, the first-run setup link in
# the log, the accounting send loop — so this gets that done without waiting
# for a visitor. --start-interval (Docker Engine 25+) checks every 2 s while
# starting, so that happens within seconds rather than after the first 30 s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/`, { redirect: 'manual' }); process.exit(r.status < 500 ? 0 : 1)"]

CMD ["bun", "run", "start"]
