// Preload job — refreshes domain authority cache for high-traffic domains.
// First run is delayed 1 hour after startup; then runs every 24 hours.

import { getMozMetrics } from "../adapters/moz.js";
import {
  setCachedDomainAuthority,
  getTopMissedDomains,
  getDomainsNeedingRefresh,
} from "../database.js";
import { logger } from "../utils/logger.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

function setTimeoutPromise(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPreloadCycle(): Promise<void> {
  try {
    const candidates = getTopMissedDomains(500);
    const toRefresh = getDomainsNeedingRefresh(candidates, REFRESH_WINDOW_MS);

    logger.info(
      `Preload job: checked ${candidates.length} candidates, ${toRefresh.length} need refresh`,
    );

    let refreshed = 0;
    let mozCalls = 0;

    for (const domain of toRefresh) {
      try {
        const result = await getMozMetrics(domain);
        setCachedDomainAuthority(domain, result);
        refreshed++;
        mozCalls++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Preload job: failed for ${domain} — ${msg}`);
      }
      await setTimeoutPromise(1000);
    }

    logger.info(
      `Preload job complete: checked ${candidates.length}, refreshed ${refreshed}, Moz calls ${mozCalls}`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Preload job: unexpected error — ${msg}`);
    // Never throw from a background job
  }
}

export function startPreloadJob(): void {
  // First run after 1 hour
  setTimeout(() => {
    void runPreloadCycle();
    // Then every 24 hours
    setInterval(() => {
      void runPreloadCycle();
    }, ONE_DAY_MS);
  }, ONE_HOUR_MS);

  logger.info("Preload job: scheduled (first run in 1 hour, then every 24 hours)");
}
