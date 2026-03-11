// DataForSEO API adapter — fetches backlink data from DataForSEO Backlinks API
// Docs: https://docs.dataforseo.com/v3/backlinks/

import type {
  DataForSeoBacklinksResponse,
  DataForSeoBacklinksResult,
  DataForSeoBacklinkItem,
  DataForSeoDomainMetrics,
  DataForSeoBacklinkEntry,
} from "../types/index.js";
import { logger } from "../utils/logger.js";

const BASE_URL = "https://api.dataforseo.com/v3";
const BACKLINKS_ENDPOINT = `${BASE_URL}/backlinks/backlinks/live`;
const TIMEOUT_MS = 25_000;
const ADAPTER = "DataForSEO";

// Env vars validated lazily at runtime (adapter not yet activated)
function getCredentials(): { readonly login: string; readonly password: string } {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;

  if (!login) {
    throw new Error(`[${ADAPTER}] Missing required env var: DATAFORSEO_LOGIN`);
  }
  if (!password) {
    throw new Error(`[${ADAPTER}] Missing required env var: DATAFORSEO_PASSWORD`);
  }

  return { login, password };
}

/**
 * Creates Basic Auth header for DataForSEO API
 */
function getAuthHeader(): string {
  const { login, password } = getCredentials();
  const credentials = Buffer.from(`${login}:${password}`).toString("base64");
  return `Basic ${credentials}`;
}

/**
 * Normalizes a DataForSEO backlink item to our internal format
 */
function normalizeBacklinkItem(item: DataForSeoBacklinkItem): DataForSeoBacklinkEntry {
  return {
    url: item.url_from,
    domain: item.domain_from,
    targetUrl: item.url_to,
    anchor: item.anchor,
    dofollow: item.dofollow,
    firstSeen: item.first_seen,
    lastSeen: item.last_seen,
    spamScore: item.backlink_spam_score,
    source: "dataforseo" as const,
  };
}

/**
 * Fetches backlink profile for a domain from DataForSEO
 * Returns summary metrics and top backlinks
 */
export async function getBacklinkProfile(
  domain: string,
  limit: number = 10,
): Promise<{
  readonly domain: string;
  readonly totalBacklinks: number;
  readonly referringDomains: number;
  readonly topBacklinks: ReadonlyArray<DataForSeoBacklinkEntry>;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    logger.log("info", `Fetching backlink profile for ${domain}`, {
      adapter: ADAPTER,
      limit,
    });

    const response = await fetch(BACKLINKS_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        {
          target: domain,
          limit,
          backlinks_status_type: "live",
        },
      ]),
    });

    if (!response.ok) {
      throw new Error(
        `[${ADAPTER}] API error ${response.status} for domain: ${domain}`,
      );
    }

    const data = (await response.json()) as DataForSeoBacklinksResponse;

    // Check for API-level errors
    if (data.status_code !== 20000) {
      throw new Error(
        `[${ADAPTER}] API returned error: ${data.status_message} (code: ${data.status_code})`,
      );
    }

    // Check for task-level errors
    if (data.tasks_error > 0 || data.tasks.length === 0) {
      throw new Error(
        `[${ADAPTER}] All tasks failed for domain: ${domain}`,
      );
    }

    const task = data.tasks[0];

    if (task.status_code !== 20000) {
      throw new Error(
        `[${ADAPTER}] Task error: ${task.status_message} (code: ${task.status_code})`,
      );
    }

    if (!task.result || task.result.length === 0) {
      return {
        domain,
        totalBacklinks: 0,
        referringDomains: 0,
        topBacklinks: [],
      };
    }

    const result: DataForSeoBacklinksResult = task.result[0];

    return {
      domain,
      totalBacklinks: result.total_count,
      referringDomains: result.items_count, // This is unique referring domains count
      topBacklinks: result.items.map(normalizeBacklinkItem),
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

/**
 * Fetches referring domains for a domain from DataForSEO
 * Returns unique referring domains with metadata
 */
export async function getReferringDomains(
  domain: string,
  limit: number = 100,
): Promise<{
  readonly domain: string;
  readonly totalFound: number;
  readonly referringDomains: ReadonlyArray<{
    readonly domain: string;
    readonly exampleUrl: string;
    readonly lastSeen: string;
    readonly backlinkCount: number;
    readonly dofollowCount: number;
  }>;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    logger.log("info", `Fetching referring domains for ${domain}`, {
      adapter: ADAPTER,
      limit,
    });

    const response = await fetch(BACKLINKS_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        {
          target: domain,
          limit,
          backlinks_status_type: "live",
        },
      ]),
    });

    if (!response.ok) {
      throw new Error(
        `[${ADAPTER}] API error ${response.status} for domain: ${domain}`,
      );
    }

    const data = (await response.json()) as DataForSeoBacklinksResponse;

    // Check for API-level errors
    if (data.status_code !== 20000) {
      throw new Error(
        `[${ADAPTER}] API returned error: ${data.status_message} (code: ${data.status_code})`,
      );
    }

    // Check for task-level errors
    if (data.tasks_error > 0 || data.tasks.length === 0) {
      throw new Error(
        `[${ADAPTER}] All tasks failed for domain: ${domain}`,
      );
    }

    const task = data.tasks[0];

    if (task.status_code !== 20000) {
      throw new Error(
        `[${ADAPTER}] Task error: ${task.status_message} (code: ${task.status_code})`,
      );
    }

    if (!task.result || task.result.length === 0) {
      return {
        domain,
        totalFound: 0,
        referringDomains: [],
      };
    }

    const result: DataForSeoBacklinksResult = task.result[0];

    // Aggregate by domain to get unique referring domains
    const domainMap = new Map<
      string,
      {
        readonly exampleUrl: string;
        readonly lastSeen: string;
        backlinkCount: number;
        dofollowCount: number;
      }
    >();

    for (const item of result.items) {
      const existing = domainMap.get(item.domain_from);
      if (existing) {
        domainMap.set(item.domain_from, {
          ...existing,
          backlinkCount: existing.backlinkCount + 1,
          dofollowCount: item.dofollow
            ? existing.dofollowCount + 1
            : existing.dofollowCount,
        });
      } else {
        domainMap.set(item.domain_from, {
          exampleUrl: item.url_from,
          lastSeen: item.last_seen,
          backlinkCount: 1,
          dofollowCount: item.dofollow ? 1 : 0,
        });
      }
    }

    const referringDomains = Array.from(domainMap.entries()).map(
      ([domainName, meta]) => ({
        domain: domainName,
        exampleUrl: meta.exampleUrl,
        lastSeen: meta.lastSeen,
        backlinkCount: meta.backlinkCount,
        dofollowCount: meta.dofollowCount,
      }),
    );

    return {
      domain,
      totalFound: referringDomains.length,
      referringDomains,
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
