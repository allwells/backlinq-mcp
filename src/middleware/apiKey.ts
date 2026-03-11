// Unified auth middleware — handles RapidAPI proxy secret, self-service API keys,
// and internal service authentication (for trusted services like the playground)

import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/db.js";
import { logger } from "../utils/logger.js";

const PLAN_LIMITS: Record<string, number> = {
  FREE: 100,
  PRO: 5000,
  ULTRA: 25000,
};

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validates API key by hash and checks quota.
 * Used by both direct API key auth and internal service auth.
 */
async function validateKeyAndUpdateUsage(
  keyHash: string,
  req: Request,
): Promise<
  | { type: "success"; userId: string }
  | { type: "invalid_key"; message: string }
  | { type: "revoked" }
  | { type: "quota_exceeded" }
> {
  const key = await prisma.apiKey
    .findUnique({
      where: { keyHash },
      include: { user: { include: { subscription: true } } },
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`API key lookup failed: ${msg}`);
      return null;
    });

  if (!key) {
    return { type: "invalid_key", message: "Invalid API key" };
  }

  if (!key.active) {
    return { type: "revoked" };
  }

  const plan = key.user.subscription?.plan ?? "FREE";
  const limit = PLAN_LIMITS[plan] ?? 100;

  if (key.currentUsage >= limit) {
    return { type: "quota_exceeded" };
  }

  // Atomic increment — never read-modify-write
  await prisma.apiKey
    .update({
      where: { id: key.id },
      data: {
        currentUsage: { increment: 1 },
        lastUsedAt: new Date(),
      },
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Usage increment failed: ${msg}`);
    });

  // Write usage record for dashboard analytics — non-blocking
  prisma.usage
    .create({
      data: {
        userId: key.userId,
        endpoint: req.path.replace(/^\//, ""),
        statusCode: 200,
      },
    })
    .catch(() => null);

  return { type: "success", userId: key.userId };
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
  const internalServiceSecret = req.headers["x-internal-service-secret"] as
    | string
    | undefined;
  const apiKeyHash = req.headers["x-api-key-hash"] as string | undefined;

  // ── Internal Service path (trusted services like playground) ─────────
  if (internalServiceSecret !== undefined) {
    const expected = process.env.INTERNAL_SERVICE_SECRET ?? "";
    if (!timingSafeCompare(internalServiceSecret, expected)) {
      res.status(401).json({
        error: true,
        code: "UNAUTHORIZED",
        message: "Invalid internal service secret",
      });
      return;
    }

    // Internal service must also provide a valid API key hash
    if (!apiKeyHash) {
      res.status(401).json({
        error: true,
        code: "UNAUTHORIZED",
        message: "Missing API key hash",
      });
      return;
    }

    const result = await validateKeyAndUpdateUsage(apiKeyHash, req);

    if (result.type === "invalid_key") {
      res.status(401).json({
        error: true,
        code: "UNAUTHORIZED",
        message: result.message,
      });
      return;
    }

    if (result.type === "revoked") {
      res.status(401).json({
        error: true,
        code: "UNAUTHORIZED",
        message: "API key has been revoked",
      });
      return;
    }

    if (result.type === "quota_exceeded") {
      res.status(429).json({
        error: true,
        code: "QUOTA_EXCEEDED",
        message: "Monthly limit reached",
        upgradeUrl: "https://backlinq.dev/dashboard/billing",
      });
      return;
    }

    // Attach userId to request for downstream use
    (req as Request & { userId?: string }).userId = result.userId;
    next();
    return;
  }

  // ── RapidAPI path ─────────────────────────────────────────
  if (rapidApiSecret !== undefined) {
    const expected = process.env.RAPIDAPI_PROXY_SECRET ?? "";
    if (!timingSafeCompare(rapidApiSecret, expected)) {
      res.status(401).json({ error: true, code: "UNAUTHORIZED", message: "Invalid API key" });
      return;
    }
    next();
    return;
  }

  // ── Self-service API key path ─────────────────────────────
  if (!apiKey) {
    res.status(401).json({ error: true, code: "UNAUTHORIZED", message: "Missing authentication" });
    return;
  }

  const hash = crypto.createHash("sha256").update(apiKey).digest("hex");
  const result = await validateKeyAndUpdateUsage(hash, req);

  if (result.type === "invalid_key") {
    res.status(401).json({
      error: true,
      code: "UNAUTHORIZED",
      message: result.message,
    });
    return;
  }

  if (result.type === "revoked") {
    res.status(401).json({
      error: true,
      code: "UNAUTHORIZED",
      message: "API key has been revoked",
    });
    return;
  }

  if (result.type === "quota_exceeded") {
    res.status(429).json({
      error: true,
      code: "QUOTA_EXCEEDED",
      message: "Monthly limit reached",
      upgradeUrl: "https://backlinq.dev/dashboard/billing",
    });
    return;
  }

  (req as Request & { userId?: string }).userId = result.userId;
  next();
}
