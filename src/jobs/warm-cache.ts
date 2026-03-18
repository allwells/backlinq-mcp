// Cache warmer — runs once at startup to pre-populate domain authority for seed domains.
// Checks if already complete before running; skips gracefully if so.

import { SEED_DOMAINS } from "../data/seed-domains.js";
import { getMozMetrics } from "../adapters/moz.js";
import {
  setCachedDomainAuthority,
  isWarmCacheComplete,
  markWarmCacheComplete,
} from "../database.js";
import { logger } from "../utils/logger.js";

function setTimeoutPromise(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCacheWarmer(): Promise<void> {
  try {
    if (process.env.SKIP_CACHE_WARM === "true") {
      logger.info("Cache warmer: disabled via SKIP_CACHE_WARM, skipping");
      return;
    }

    if (isWarmCacheComplete()) {
      logger.info("Cache warmer: already complete, skipping");
      return;
    }

    logger.info(`Cache warmer: starting — ${SEED_DOMAINS.length} domains to process`);
    let count = 0;

    for (const domain of SEED_DOMAINS) {
      try {
        const result = await getMozMetrics(domain);
        setCachedDomainAuthority(domain, result);
        count++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Cache warmer: failed for ${domain} — ${msg}`);
      }

      if (count > 0 && count % 100 === 0) {
        logger.info(`Cache warmer: ${count}/${SEED_DOMAINS.length} domains processed`);
      }

      await setTimeoutPromise(1000);
    }

    markWarmCacheComplete(count);
    logger.info(`Cache warmer complete: ${count} domains warmed`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Cache warmer: unexpected error — ${msg}`);
    // Never throw — startup must not fail due to cache warming
  }
}
