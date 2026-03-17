// Common Crawl Index API adapter — fallback when Moz returns empty
// Docs: https://index.commoncrawl.org/
// Results are cached for 24h — WAT file parsing is expensive.

import type { CommonCrawlRecord, BacklinkEntry } from "../types/index.js";
import { cache, TTL_24H } from "../utils/cache.js";
import { logger } from "../utils/logger.js";

// Latest crawl index — update this quarterly
const INDEX_URL = "https://index.commoncrawl.org/CC-MAIN-2026-08-index";
const TIMEOUT_MS = 25_000;
const ADAPTER = "CommonCrawl";

/**
 * Extracts the effective root domain (eTLD+1 approximation) from a hostname.
 * Strips leading "www." so that www.example.com and example.com compare equal.
 */
function getRootDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Returns true if the crawl record is a self-redirect of the target domain.
 * E.g. http://github.com -> https://github.com, or www.github.com -> github.com.
 * These are protocol/www normalisation redirects, not real backlinks.
 */
function isSelfRedirect(
  record: CommonCrawlRecord,
  targetDomain: string,
): boolean {
  const status = parseInt(record.status, 10);
  if (status < 300 || status >= 400) {
    return false;
  }

  try {
    const recordRoot = getRootDomain(new URL(record.url).hostname);
    const targetRoot = getRootDomain(targetDomain);
    return recordRoot === targetRoot;
  } catch {
    return false;
  }
}

/**
 * Returns true if the crawled URL belongs to the target domain itself.
 *
 * The Common Crawl query `*.domain/*` returns pages that were crawled *under*
 * the given domain -- i.e. pages ON the domain, not pages linking TO it from
 * an external site. We discard these so only genuinely external URLs remain.
 */
function isSelfEntry(record: CommonCrawlRecord, targetDomain: string): boolean {
  try {
    const recordRoot = getRootDomain(new URL(record.url).hostname);
    const targetRoot = getRootDomain(targetDomain);
    return recordRoot === targetRoot;
  } catch {
    return false;
  }
}

export async function getBacklinksFromCrawl(
  domain: string,
  limit: number = 10,
): Promise<BacklinkEntry[]> {
  if (limit <= 0) {
    return [];
  }

  const cacheKey = `crawl:${domain}:${limit}`;
  const cached = cache.get<BacklinkEntry[]>(cacheKey);
  if (cached) {
    logger.info(`CommonCrawl cache hit for ${domain} (limit=${limit})`, {
      adapter: ADAPTER,
    });
    return cached;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = new URL(INDEX_URL);
    url.searchParams.set("url", `*.${domain}/*`);
    url.searchParams.set("output", "json");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("fl", "url,timestamp,status,mime");

    logger.info(`Fetching up to ${limit} crawl records for ${domain}`, {
      adapter: ADAPTER,
      queryUrl: url.toString(),
    });

    const response = await fetch(url.toString(), {
      signal: controller.signal,
    });

    // Common Crawl returns 404 for domains with no index entries -- treat as empty
    if (response.status === 404) {
      throw new Error(
        `[${ADAPTER}] No crawl records found for domain: ${domain}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `[${ADAPTER}] API error ${response.status} for domain: ${domain}`,
      );
    }

    // Response is newline-delimited JSON (NDJSON)
    const text = await response.text();

    if (!text.trim()) {
      throw new Error(`[${ADAPTER}] Empty response text for domain: ${domain}`);
    }

    const records: BacklinkEntry[] = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const record = JSON.parse(line) as CommonCrawlRecord;
        return record;
      })
      // Filter out records that are the target domain's own pages.
      .filter((record) => !isSelfEntry(record, domain))
      // Additionally filter out self-redirects (http->https, www->non-www).
      .filter((record) => !isSelfRedirect(record, domain))
      .map((record) => ({
        url: record.url,
        timestamp: record.timestamp,
        status: record.status,
        source: "commoncrawl" as const,
      }));

    if (records.length === 0) {
      throw new Error(
        `[${ADAPTER}] No external backlinks found in recent crawl records for domain: ${domain}`,
      );
    }

    // Cache the result for 24h to avoid re-fetching large crawl segments
    cache.set(cacheKey, records, TTL_24H);

    return records;
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
 * Normalises a hostname to its root domain, collapsing subdomains.
 * blog.example.com → example.com, shop.example.com → example.com
 */
export function normaliseToRootDomain(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/^www\./, "");
  const parts = lower.split(".");
  if (parts.length <= 2) return lower;

  const tld = parts[parts.length - 1]!;
  // Quick two-part TLD heuristic (co.uk, com.au, etc.)
  if (
    parts.length > 3 &&
    (tld === "uk" || tld === "au" || tld === "nz" || tld === "za") &&
    parts[parts.length - 2]!.length <= 3
  ) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}
