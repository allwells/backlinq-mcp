// Per-IP in-memory rate limiter — no Redis needed
// Applied to all /api/* routes via server.ts

import type { Request, Response, NextFunction } from "express";

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 60; // max requests per window per IP

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

export function rateLimiter(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ip: string = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const entry = store.get(ip);

  if (!entry || now >= entry.resetAt) {
    store.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  if (entry.count >= MAX_REQUESTS) {
    res.status(429).json({
      error: true,
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests",
    });
    return;
  }

  entry.count++;
  next();
}
