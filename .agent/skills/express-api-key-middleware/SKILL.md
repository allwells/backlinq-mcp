# API Key Middleware Skill

## What This Skill Covers

Adding self-service API key authentication to the `backlinq-api` Express server alongside the existing RapidAPI middleware. Uses Prisma + Supabase directly for key validation and usage metering.

## Context

This is an Express server (`src/server.ts`), not Next.js. Middleware lives in `src/middleware/`. The existing `src/middleware/rapidApi.ts` handles RapidAPI auth — this skill extends that to support direct API keys from Backlinq's self-service dashboard.

## Installation

```bash
bun add prisma @prisma/client
bunx prisma init
```

## Additional Environment Variables

```env
# Add to existing .env
DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres
API_KEY_HASH_SECRET=   # Same value as in backlinq-app
```

## Prisma Client

```typescript
// src/lib/db.ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

## Middleware Implementation

```typescript
// src/middleware/apiKey.ts
import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/db.js";

const PLAN_LIMITS: Record<string, number> = {
  FREE: 100,
  PRO: 5000,
  ULTRA: 25000,
};

function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function apiKeyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rapidApiSecret = req.headers["x-rapidapi-proxy-secret"] as
    | string
    | undefined;
  const apiKey = req.headers["x-api-key"] as string | undefined;

  // ── RapidAPI path ─────────────────────────────────────────
  if (rapidApiSecret !== undefined) {
    const expected = process.env.RAPIDAPI_PROXY_SECRET ?? "";
    if (!timingSafeCompare(rapidApiSecret, expected)) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    // Valid RapidAPI request — skip internal metering
    next();
    return;
  }

  // ── Self-service path ─────────────────────────────────────
  if (!apiKey) {
    res.status(401).json({ error: "Missing authentication" });
    return;
  }

  const hash = crypto.createHash("sha256").update(apiKey).digest("hex");

  const key = await prisma.apiKey
    .findUnique({
      where: { keyHash: hash },
      include: { user: { include: { subscription: true } } },
    })
    .catch(() => null);

  if (!key || !key.active) {
    res
      .status(401)
      .json({ error: key ? "API key has been revoked" : "Invalid API key" });
    return;
  }

  const plan = key.user.subscription?.plan ?? "FREE";
  const limit = PLAN_LIMITS[plan] ?? 100;

  if (key.currentUsage >= limit) {
    res.status(429).json({
      error: "Monthly limit reached",
      upgradeUrl: "https://backlinq.dev/dashboard/billing",
    });
    return;
  }

  // Atomic increment
  await prisma.apiKey.update({
    where: { id: key.id },
    data: {
      currentUsage: { increment: 1 },
      lastUsedAt: new Date(),
    },
  });

  // Write usage record for dashboard analytics
  await prisma.usage
    .create({
      data: {
        userId: key.userId,
        endpoint: req.path.replace("/api/v1/", "").replace("/", ""),
        statusCode: 200,
      },
    })
    .catch(() => null); // Non-blocking — never fail a request over analytics

  next();
}
```

## Registering in server.ts

```typescript
// src/server.ts — add after existing middleware setup
import { apiKeyMiddleware } from "./middleware/apiKey.js";

// Replace or wrap existing rapidApi middleware with unified handler
app.use("/api/v1", apiKeyMiddleware);
```

The existing `src/middleware/rapidApi.ts` can be retired — `apiKeyMiddleware` handles both auth paths in the correct priority order.

## Prisma Schema (subset needed in API project)

The API project only needs to READ these models — it does not own the schema. Add a minimal read-focused setup:

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

// Mirror of backlinq-app schema — do not migrate from this project
// Run migrations from backlinq-app only
model User {
  id           String        @id
  email        String        @unique
  apiKeys      ApiKey[]
  subscription Subscription?
}

model ApiKey {
  id           String    @id
  userId       String
  keyHash      String    @unique
  prefix       String
  active       Boolean
  currentUsage Int
  cycleStartedAt DateTime
  lastUsedAt   DateTime?
  createdAt    DateTime
  user         User      @relation(fields: [userId], references: [id])
}

model Subscription {
  id     String @id
  userId String @unique
  plan   String
  status String
  user   User   @relation(fields: [userId], references: [id])
}

model Usage {
  id         String   @id @default(cuid())
  userId     String
  endpoint   String
  statusCode Int
  createdAt  DateTime @default(now())
}
```

**Critical:** Only run `prisma generate` from this project — never `prisma migrate`. Schema ownership and migrations belong to `backlinq-app` exclusively.

## SSRF Prevention

Existing `src/utils/validator.ts` already handles domain validation. Ensure it blocks:

- Private IP ranges (`10.x`, `172.16-31.x`, `192.168.x`, `127.x`)
- `localhost`, `169.254.169.254` (AWS metadata)
- IPv6 loopback `::1`

Do not duplicate — call the existing `assertValidDomain()` in tool handlers as already implemented.

## Common Mistakes

- Running `prisma migrate` from the API project — migrations run from `backlinq-app` only
- Not catching Prisma errors in middleware — a database blip should not crash auth
- Using `===` for secret comparison — always `timingSafeEqual`
- Making the usage write blocking — wrap in `.catch(() => null)`, never fail a request over analytics
- Forgetting `?pgbouncer=true` on `DATABASE_URL` — breaks prepared statements on Render
