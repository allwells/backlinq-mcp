// Moz Links API v2 adapter — primary data source for all 4 MCP tools
// Docs: https://moz.com/products/api/getting-started
// Paid plan active — all endpoints available (up to 200 req/s)

import type {
  MozDomainMetrics,
  MozMetricsResponse,
  MozLinksResponse,
  MozLink,
  MozLinkingRootDomainsResponse,
  MozLinkingRootDomain,
} from "../types/index.js";
import { logger } from "../utils/logger.js";

const BASE_URL = "https://lsapi.seomoz.com/v2";
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

const CREDENTIALS = Buffer.from(`${MOZ_ACCESS_ID}:${MOZ_SECRET_KEY}`).toString("base64");

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Basic ${CREDENTIALS}`,
    "Content-Type": "application/json",
  };
}

function mozTarget(domain: string): string {
  return `https://${domain}/`;
}

// ─── url_metrics ─────────────────────────────────────────────────────────────

/**
 * Fetches domain-level authority metrics for one or more domains.
 * Returns DA, spam score, linksIn, MozRank, and referring root domain count.
 * Accepts up to 50 targets in one call — used for batching in compare_domains.
 */
export async function getMozMetrics(domain: string): Promise<MozDomainMetrics>;
export async function getMozMetrics(
  domains: readonly string[],
): Promise<readonly MozDomainMetrics[]>;
export async function getMozMetrics(
  domainOrDomains: string | readonly string[],
): Promise<MozDomainMetrics | readonly MozDomainMetrics[]> {
  const domains = Array.isArray(domainOrDomains)
    ? (domainOrDomains as readonly string[])
    : [domainOrDomains as string];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    logger.info(`Fetching Moz url_metrics for ${domains.join(", ")}`, {
      adapter: ADAPTER,
    });

    const response = await fetch(`${BASE_URL}/url_metrics`, {
      method: "POST",
      signal: controller.signal,
      headers: authHeaders(),
      body: JSON.stringify({
        targets: domains.map(mozTarget),
      }),
    });

    if (!response.ok) {
      throw new Error(
        `[${ADAPTER}] url_metrics API error ${response.status} for: ${domains.join(", ")}`,
      );
    }

    const data = (await response.json()) as MozMetricsResponse;

    if (!data.results || data.results.length === 0) {
      throw new Error(`[${ADAPTER}] Empty url_metrics response for: ${domains.join(", ")}`);
    }

    const normalized: MozDomainMetrics[] = data.results.map((result, i) => ({
      domain: domains[i] ?? domains[0],
      domainAuthority: Number(result.domain_authority ?? 0),
      spamScore: Math.max(0, Number(result.spam_score ?? 0)),
      // pages_to_root_domain is the total inbound link count in Moz v2
      linksIn:
        result.pages_to_root_domain !== undefined
          ? Math.max(0, Number(result.pages_to_root_domain))
          : undefined,
      // page_authority is 0–100; divide by 10 to produce a 0–10 PageRank proxy
      mozRank: Number(result.page_authority ?? 0) / 10,
      rootDomainsCount:
        result.root_domains_to_root_domain !== undefined
          ? Math.max(0, Number(result.root_domains_to_root_domain))
          : undefined,
      source: "moz",
    }));

    return typeof domainOrDomains === "string" ? normalized[0]! : normalized;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new Error(
        `[${ADAPTER}] url_metrics timed out after ${TIMEOUT_MS}ms for: ${domains.join(", ")}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── /v2/links ────────────────────────────────────────────────────────────────

/**
 * Fetches individual backlink records for a domain.
 * Returns source URLs, anchor text, and follow/nofollow status.
 * HTTP status codes are not available from Moz — status field is set to "N/A".
 */
export async function getMozLinks(
  domain: string,
  limit: number = 25,
): Promise<readonly MozLink[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    logger.info(`Fetching Moz links for ${domain} (limit=${limit})`, {
      adapter: ADAPTER,
    });

    const response = await fetch(`${BASE_URL}/links`, {
      method: "POST",
      signal: controller.signal,
      headers: authHeaders(),
      body: JSON.stringify({
        target: mozTarget(domain),
        scope: "root_domain",
        limit,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `[${ADAPTER}] links API error ${response.status} for domain: ${domain}`,
      );
    }

    const data = (await response.json()) as MozLinksResponse;

    if (!data.results) {
      return [];
    }

    return data.results;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new Error(
        `[${ADAPTER}] links timed out after ${TIMEOUT_MS}ms for domain: ${domain}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── /v2/linking_root_domains ─────────────────────────────────────────────────

/**
 * Fetches the list of root domains linking to a target domain.
 * Returns domain name, DA, linking page count, and nofollow count.
 */
export async function getMozLinkingRootDomains(
  domain: string,
  limit: number = 50,
): Promise<readonly MozLinkingRootDomain[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    logger.info(
      `Fetching Moz linking_root_domains for ${domain} (limit=${limit})`,
      { adapter: ADAPTER },
    );

    const response = await fetch(`${BASE_URL}/linking_root_domains`, {
      method: "POST",
      signal: controller.signal,
      headers: authHeaders(),
      body: JSON.stringify({
        target: mozTarget(domain),
        scope: "root_domain",
        limit,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `[${ADAPTER}] linking_root_domains API error ${response.status} for domain: ${domain}`,
      );
    }

    const data = (await response.json()) as MozLinkingRootDomainsResponse;

    if (!data.results) {
      return [];
    }

    return data.results;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new Error(
        `[${ADAPTER}] linking_root_domains timed out after ${TIMEOUT_MS}ms for domain: ${domain}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
