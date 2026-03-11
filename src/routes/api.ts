// REST API routes for RapidAPI listing
// All four MCP tools exposed as GET endpoints with correct HTTP status codes.
// Reuses existing adapters, validators, and formatters — no business logic duplicated.

import { Router } from "express";
import type { Request, Response } from "express";
import type {
  BacklinkEntry,
  BacklinkProfile,
  CompareDomainsRestOutput,
  DomainAuthorityOutput,
  DomainRankResult,
  LeaderboardEntry,
  MozDomainMetrics,
  ReferringDomain,
  ReferringDomainsOutput,
} from "../types/index.js";
import { getDomainPageRank } from "../adapters/openPageRank.js";
import { getMozMetrics } from "../adapters/moz.js";
import { getBacklinksFromCrawl } from "../adapters/commonCrawl.js";
import {
  cleanDomain,
  assertValidDomain,
  extractRootDomain,
} from "../utils/validator.js";
import { formatBacklinkProfile, formatError } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";

export const apiRouter = Router();

// ─── Internal helper types ────────────────────────────────────────────────────

interface BacklinkFetchResult {
  backlinks: BacklinkEntry[];
  note?: string;
}

interface DomainMetricsResult {
  domain: string;
  rank: DomainRankResult;
  moz: MozDomainMetrics;
}

// ─── Helper functions ─────────────────────────────────────────────────────────

/**
 * Parses a query-string limit param. Returns the clamped value, the default
 * if the param is absent, or null if the value is invalid (non-numeric / <=0).
 */
function parseLimitParam(
  raw: unknown,
  defaultVal: number,
  max: number,
): number | null {
  if (raw === undefined) return defaultVal;
  const n = parseInt(String(raw), 10);
  if (isNaN(n) || n <= 0) return null;
  return Math.min(n, max);
}

/**
 * Fetches backlinks for a domain via Common Crawl, with automatic subdomain
 * fallback: if the target is a subdomain and no data is found, retries against
 * the root domain and attaches a descriptive note to the result.
 */
async function fetchBacklinksWithFallback(
  domain: string,
  limit: number,
): Promise<BacklinkFetchResult> {
  try {
    const backlinks = await getBacklinksFromCrawl(domain, limit);
    return { backlinks };
  } catch (crawlErr: unknown) {
    const isSubdomain = extractRootDomain(domain) !== domain;
    if (!isSubdomain) throw crawlErr;
    const root = extractRootDomain(domain);
    logger.info(`No backlinks for subdomain ${domain}, falling back to ${root}`);
    const backlinks = await getBacklinksFromCrawl(root, limit);
    return { backlinks, note: "No subdomain data found, showing root domain results" };
  }
}

/**
 * Deduplicates a backlink list into unique referring root domains (www-stripped).
 * Stops once `limit` unique domains are found. Mirrors the unexported version
 * in src/tools/referringDomains.ts.
 */
function extractReferringDomains(
  backlinks: readonly BacklinkEntry[],
  limit: number,
): ReferringDomain[] {
  const seen = new Map<string, ReferringDomain>();
  for (const entry of backlinks) {
    if (seen.size >= limit) break;
    try {
      const hostname = new URL(entry.url).hostname.replace(/^www\./, "");
      if (!seen.has(hostname)) {
        seen.set(hostname, {
          domain: hostname,
          exampleUrl: entry.url,
          lastSeen: entry.timestamp,
          source: "commoncrawl",
        });
      }
    } catch {
      // Skip malformed URLs
    }
  }
  return Array.from(seen.values());
}

/**
 * Sorts N domain metric results into a ranked leaderboard.
 * Primary sort: domainAuthority descending. Tiebreaker: pageRank descending.
 */
function buildLeaderboard(results: DomainMetricsResult[]): LeaderboardEntry[] {
  return results
    .map((r) => ({
      rank: 0, // placeholder — assigned after sort
      domain: r.domain,
      pageRank: Number(r.rank.pageRank),
      domainAuthority: Number(r.moz.domainAuthority),
      spamScore: Number(r.moz.spamScore),
      ...(r.moz.linksIn !== undefined ? { linksIn: Number(r.moz.linksIn) } : {}),
    }))
    .sort(
      (a, b) =>
        b.domainAuthority - a.domainAuthority || b.pageRank - a.pageRank,
    )
    .map((entry, i) => ({ ...entry, rank: i + 1 }));
}

// ─── Route: GET /api/domain-authority ────────────────────────────────────────

apiRouter.get("/domain-authority", async (req: Request, res: Response) => {
  const rawDomain = req.query["domain"];
  if (typeof rawDomain !== "string") {
    res.status(400).json(formatError("INVALID_INPUT", "Missing required query param: domain"));
    return;
  }
  try {
    assertValidDomain(rawDomain);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json(formatError("INVALID_DOMAIN", msg));
    return;
  }
  const domain = cleanDomain(rawDomain);
  logger.info(`REST GET /api/domain-authority for: ${domain}`);
  try {
    const [rankResult, mozResult] = await Promise.all([
      getDomainPageRank(domain),
      getMozMetrics(domain),
    ]);
    const output: DomainAuthorityOutput = {
      domain,
      pageRank: Number(rankResult.pageRank),
      rank: String(rankResult.rank),
      domainAuthority: Number(mozResult.domainAuthority),
      spamScore: Number(mozResult.spamScore),
      ...(mozResult.linksIn !== undefined ? { linksIn: Number(mozResult.linksIn) } : {}),
    };
    res.status(200).json(output);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`REST /api/domain-authority failed: ${msg}`);
    res.status(500).json(formatError("DOMAIN_AUTHORITY_ERROR", msg));
  }
});

// ─── Route: GET /api/backlink-profile ────────────────────────────────────────

apiRouter.get("/backlink-profile", async (req: Request, res: Response) => {
  const rawDomain = req.query["domain"];
  if (typeof rawDomain !== "string") {
    res.status(400).json(formatError("INVALID_INPUT", "Missing required query param: domain"));
    return;
  }
  try {
    assertValidDomain(rawDomain);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json(formatError("INVALID_DOMAIN", msg));
    return;
  }
  const limit = parseLimitParam(req.query["limit"], 20, 100);
  if (limit === null) {
    res.status(400).json(formatError("INVALID_INPUT", "limit must be a positive integer (max 100)"));
    return;
  }
  const domain = cleanDomain(rawDomain);
  logger.info(`REST GET /api/backlink-profile for: ${domain} (limit=${limit})`);
  try {
    const [rankResult, { backlinks, note }] = await Promise.all([
      getDomainPageRank(domain),
      fetchBacklinksWithFallback(domain, limit),
    ]);
    const profile: BacklinkProfile & { note?: string } = {
      ...formatBacklinkProfile(domain, rankResult, backlinks),
      note,
    };
    res.status(200).json(profile);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`REST /api/backlink-profile failed: ${msg}`);
    res.status(500).json(formatError("BACKLINK_PROFILE_ERROR", msg));
  }
});

// ─── Route: GET /api/referring-domains ───────────────────────────────────────

apiRouter.get("/referring-domains", async (req: Request, res: Response) => {
  const rawDomain = req.query["domain"];
  if (typeof rawDomain !== "string") {
    res.status(400).json(formatError("INVALID_INPUT", "Missing required query param: domain"));
    return;
  }
  try {
    assertValidDomain(rawDomain);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json(formatError("INVALID_DOMAIN", msg));
    return;
  }
  const limit = parseLimitParam(req.query["limit"], 50, 100);
  if (limit === null) {
    res.status(400).json(formatError("INVALID_INPUT", "limit must be a positive integer (max 100)"));
    return;
  }
  const domain = cleanDomain(rawDomain);
  logger.info(`REST GET /api/referring-domains for: ${domain} (limit=${limit})`);
  try {
    const { backlinks, note } = await fetchBacklinksWithFallback(domain, 200);
    const referringDomains = extractReferringDomains(backlinks, limit);
    const output: ReferringDomainsOutput & { note?: string } = {
      domain,
      totalFound: referringDomains.length,
      referringDomains,
      note,
    };
    res.status(200).json(output);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`REST /api/referring-domains failed: ${msg}`);
    res.status(500).json(formatError("REFERRING_DOMAINS_ERROR", msg));
  }
});

// ─── Route: GET /api/compare-domains ─────────────────────────────────────────

const MIN_DOMAINS = 2;
const MAX_DOMAINS = 5;

apiRouter.get("/compare-domains", async (req: Request, res: Response) => {
  const domainsParam = req.query["domains"];
  if (typeof domainsParam !== "string") {
    res.status(400).json(formatError("INVALID_INPUT", "Missing required query param: domains"));
    return;
  }
  const rawDomains = domainsParam.split(",").map((d) => d.trim()).filter(Boolean);
  if (rawDomains.length < MIN_DOMAINS || rawDomains.length > MAX_DOMAINS) {
    res.status(400).json(
      formatError("INVALID_INPUT", `Provide ${MIN_DOMAINS}–${MAX_DOMAINS} comma-separated domains`),
    );
    return;
  }
  for (const raw of rawDomains) {
    try {
      assertValidDomain(raw);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json(formatError("INVALID_DOMAIN", `Invalid domain "${raw}": ${msg}`));
      return;
    }
  }
  const domains = rawDomains.map(cleanDomain);
  logger.info(`REST GET /api/compare-domains: ${domains.join(", ")}`);
  try {
    const results: DomainMetricsResult[] = await Promise.all(
      domains.map(async (domain) => {
        const [rank, moz] = await Promise.all([getDomainPageRank(domain), getMozMetrics(domain)]);
        return { domain, rank, moz };
      }),
    );
    const leaderboard = buildLeaderboard(results);
    const output: CompareDomainsRestOutput = { domains, leaderboard };
    res.status(200).json(output);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`REST /api/compare-domains failed: ${msg}`);
    res.status(500).json(formatError("COMPARE_DOMAINS_ERROR", msg));
  }
});
