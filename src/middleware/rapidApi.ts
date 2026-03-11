// RapidAPI proxy secret authentication middleware
// Applied to all /api/* routes via server.ts
// Docs: https://docs.rapidapi.com/docs/proxy-secret-key

import type { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";

export function rapidApiAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = process.env.RAPIDAPI_PROXY_SECRET;

  if (!secret) {
    logger.warn(
      "RAPIDAPI_PROXY_SECRET not set — RapidAPI auth disabled. " +
        "Set this env var in production before deploying.",
    );
    next();
    return;
  }

  const header = req.headers["x-rapidapi-proxy-secret"];

  if (!header || header !== secret) {
    res.status(401).json({
      error: true,
      code: "UNAUTHORIZED",
      message: "Invalid API key",
    });
    return;
  }

  next();
}
