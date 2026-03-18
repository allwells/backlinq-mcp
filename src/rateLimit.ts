// Rate limit tracking for Moz API calls.
// Reads MOZ_HOURLY_LIMIT (default 200) and MOZ_DAILY_LIMIT (default 2000) from env.

import { recordMozApiCall, getMozCallsInWindow } from "./database.js";

const MOZ_HOURLY_LIMIT = Number(process.env.MOZ_HOURLY_LIMIT ?? 200);
const MOZ_DAILY_LIMIT = Number(process.env.MOZ_DAILY_LIMIT ?? 2000);

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function recordApiCall(
  endpoint: string,
  domain: string,
  status: number,
  responseTimeMs: number,
): void {
  recordMozApiCall(endpoint, domain, status, responseTimeMs);
}

export function getCallsInLastHour(): number {
  return getMozCallsInWindow(ONE_HOUR_MS);
}

export function getCallsInLastDay(): number {
  return getMozCallsInWindow(ONE_DAY_MS);
}

/** Returns true if calls in the last hour are >= 80% of the hourly limit. */
export function isApproachingLimit(): boolean {
  const hourly = getCallsInLastHour();
  if (hourly >= MOZ_HOURLY_LIMIT * 0.8) return true;
  const daily = getCallsInLastDay();
  if (daily >= MOZ_DAILY_LIMIT * 0.8) return true;
  return false;
}
