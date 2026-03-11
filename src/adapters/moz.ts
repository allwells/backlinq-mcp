// Moz API adapter — fetches domain authority and spam score
// Docs: https://moz.com/products/api/getting-started
// ⚠️  Free tier: 10 requests/month — use sparingly (only in get_domain_authority + compare_domains)

import type { MozMetricsResponse, MozDomainMetrics } from "../types/index.js";
import { logger } from "../utils/logger.js";

const BASE_URL = "https://lsapi.seomoz.com/v2/url_metrics";
const TIMEOUT_MS = 25_000;
const ADAPTER = "Moz";

// Validate env vars at module load
const MOZ_ACCESS_ID = process.env.MOZ_ACCESS_ID;
const MOZ_SECRET_KEY = process.env.MOZ_SECRET_KEY;

if (!MOZ_ACCESS_ID) {
  throw new Error("[Moz] Missing required env var: MOZ_ACCESS_ID");
}
if (!MOZ_SECRET_KEY) {
  throw new Error("[Moz] Missing required env var: MOZ_SECRET_KEY");
}

export async function getMozMetrics(domain: string): Promise<MozDomainMetrics> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const credentials = Buffer.from(
    `${MOZ_ACCESS_ID}:${MOZ_SECRET_KEY}`,
  ).toString("base64");

  try {
    logger.log("info", `Fetching Moz metrics for ${domain}`, {
      adapter: ADAPTER,
    });

    const response = await fetch(BASE_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targets: [`https://${domain}/`],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `[${ADAPTER}] API error ${response.status} for domain: ${domain}`,
      );
    }

    const data = (await response.json()) as MozMetricsResponse;

    if (!data.results || data.results.length === 0) {
      throw new Error(`[${ADAPTER}] Empty response for domain: ${domain}`);
    }

    const result = data.results[0];

    return {
      domain,
      domainAuthority: Number(result.domain_authority),
      // Clamp to 0 — Moz uses -1 as a sentinel when data is unavailable
      spamScore: Math.max(0, Number(result.spam_score)),
      ...(result.links_in !== undefined
        ? { linksIn: Math.max(0, Number(result.links_in)) }
        : {}),
      source: "moz",
    };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new Error(
        `[${ADAPTER}] Request timed out after ${TIMEOUT_MS}ms for domain: ${domain}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
