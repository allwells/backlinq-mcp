// Open PageRank API adapter — fetches domain page rank scores
// Docs: https://www.domcop.com/openpagerank/documentation

import type { OpenPageRankResponse, DomainRankResult } from "../types/index.js";
import { logger } from "../utils/logger.js";

const BASE_URL = "https://openpagerank.com/api/v1.0/getPageRank";
const TIMEOUT_MS = 25_000;
const ADAPTER = "OpenPageRank";

// Validate env var at module load so failures are loud and early
const API_KEY = process.env.OPEN_PAGERANK_API_KEY;
if (!API_KEY) {
  throw new Error(
    "[OpenPageRank] Missing required env var: OPEN_PAGERANK_API_KEY",
  );
}

const VALIDATED_API_KEY: string = API_KEY;

export async function getDomainPageRank(
  domain: string,
): Promise<DomainRankResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = new URL(BASE_URL);
    url.searchParams.set("domains[]", domain);

    logger.log("info", `Fetching page rank for ${domain}`, {
      adapter: ADAPTER,
    });

    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        "API-OPR": VALIDATED_API_KEY,
      },
    });

    if (!response.ok) {
      throw new Error(
        `[${ADAPTER}] API error ${response.status} for domain: ${domain}`,
      );
    }

    const data = (await response.json()) as OpenPageRankResponse;

    if (!data.response || data.response.length === 0) {
      throw new Error(`[${ADAPTER}] Empty response for domain: ${domain}`);
    }

    const result = data.response[0];

    return {
      domain: result.domain,
      pageRank: Number(result.page_rank_decimal),
      rank: String(result.rank),
      source: "openpagerank",
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
