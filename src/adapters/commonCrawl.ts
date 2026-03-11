// Common Crawl Index API adapter — discovers pages crawled under a domain
// Docs: https://index.commoncrawl.org/

import type { CommonCrawlRecord, BacklinkEntry } from "../types/index.js";
import { logger } from "../utils/logger.js";
// Import DataForSEO adapter — commented out until funded
// import * as dataForSeo from "./dataForSeo.js";

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
  // Only HTTP redirect status codes are candidates
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = new URL(INDEX_URL);
    url.searchParams.set("url", `*.${domain}/*`);
    url.searchParams.set("output", "json");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("fl", "url,timestamp,status,mime");

    logger.log("info", `Fetching up to ${limit} crawl records for ${domain}`, {
      adapter: ADAPTER,
      queryUrl: url.toString(),
    });

    const response = await fetch(url.toString(), {
      signal: controller.signal,
    });

    // Common Crawl returns 404 for domains with no index entries -- treat as empty
    if (response.status === 404) {
      logger.log("warn", `No crawl records found for ${domain}`, {
        adapter: ADAPTER,
      });
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
      // Common Crawl `*.domain/*` returns pages crawled under the domain,
      // not pages from external sites linking to it. These self-entries are
      // not backlinks and must be excluded.
      .filter((record) => !isSelfEntry(record, domain))
      // Additionally filter out self-redirects (http->https, www->non-www)
      // within the same root domain as the target.
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
 * Returns a backlink profile for the target domain.
 * Tries DataForSEO first (when funded), falls back to Common Crawl.
 */
export async function getBacklinkProfile(
  domain: string,
): Promise<{
  readonly domain: string;
  readonly totalBacklinks: number;
  readonly referringDomains: number;
  readonly topBacklinks: ReadonlyArray<BacklinkEntry>;
}> {
  // --- DataForSEO (activate when funded) ---
  // const data = await dataForSeo.getBacklinkProfile(domain);
  // return {
  //   domain: data.domain,
  //   totalBacklinks: data.totalBacklinks,
  //   referringDomains: data.referringDomains,
  //   topBacklinks: data.topBacklinks.map((b) => ({
  //     url: b.url,
  //     timestamp: b.lastSeen,
  //     status: "200",
  //     source: "dataforseo" as const,
  //   })),
  // };
  // -----------------------------------------

  // Fallback to Common Crawl
  const backlinks = await getBacklinksFromCrawl(domain, 10);
  return {
    domain,
    totalBacklinks: backlinks.length,
    referringDomains: new Set(backlinks.map((b) => new URL(b.url).hostname))
      .size,
    topBacklinks: backlinks,
  };
}

/**
 * Returns referring domains for the target domain.
 * Tries DataForSEO first (when funded), falls back to Common Crawl.
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
  }>;
}> {
  // --- DataForSEO (activate when funded) ---
  // const data = await dataForSeo.getReferringDomains(domain, limit);
  // return {
  //   domain: data.domain,
  //   totalFound: data.totalFound,
  //   referringDomains: data.referringDomains.map((d) => ({
  //     domain: d.domain,
  //     exampleUrl: d.exampleUrl,
  //     lastSeen: d.lastSeen,
  //   })),
  // };
  // -----------------------------------------

  // Fallback to Common Crawl
  const backlinks = await getBacklinksFromCrawl(domain, limit);
  const domainMap = new Map<
    string,
    { readonly exampleUrl: string; readonly lastSeen: string }
  >();

  for (const backlink of backlinks) {
    try {
      const hostname = new URL(backlink.url).hostname;
      if (!domainMap.has(hostname)) {
        domainMap.set(hostname, {
          exampleUrl: backlink.url,
          lastSeen: backlink.timestamp,
        });
      }
    } catch {
      // Skip invalid URLs
      continue;
    }
  }

  const referringDomains = Array.from(domainMap.entries()).map(
    ([domainName, meta]) => ({
      domain: domainName,
      exampleUrl: meta.exampleUrl,
      lastSeen: meta.lastSeen,
    }),
  );

  return {
    domain,
    totalFound: referringDomains.length,
    referringDomains,
  };
}
