# ── Build stage ───────────────────────────────────────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY prisma ./prisma
RUN bunx prisma generate

COPY src ./src
COPY tsconfig.json ./
RUN bunx tsc

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

CMD ["node", "dist/index.js"]
