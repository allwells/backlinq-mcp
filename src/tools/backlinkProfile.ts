// Tool: get_backlink_profile
// Primary: Moz /v2/links + url_metrics
// Fallback: Common Crawl CDX index (cached 24h)

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BacklinkProfile, BacklinkEntry, McpError } from "../types/index.js";
import { getMozMetrics, getMozLinks } from "../adapters/moz.js";
import { getBacklinksFromCrawl } from "../adapters/commonCrawl.js";
import {
  cleanDomain,
  assertValidDomain,
  extractRootDomain,
} from "../utils/validator.js";
import { formatBacklinkProfile, formatError } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";
import {
  getCachedDomainAuthority,
  setCachedDomainAuthority,
  getCachedBacklinks,
  setCachedBacklinks,
  logQuery,
} from "../database.js";

const TOOL_NAME = "get_backlink_profile" as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const inputSchema = {
  domain: z.string().describe("The domain to analyse, e.g. example.com"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(
      `Max number of backlinks to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
    ),
};

const backlinkEntrySchema = z.object({
  url: z.string().describe("URL of the page linking to the domain."),
  timestamp: z.string().describe("Crawl or index timestamp (ISO or YYYYMMDDHHMMSS)."),
  status: z
    .string()
    .describe(
      "HTTP status code from source, 'N/A' when the data source does not provide it.",
    ),
  source: z
    .enum(["commoncrawl", "dataforseo", "moz"])
    .describe("Data source that provided this backlink."),
});

const outputSchema = {
  domain: z.string().describe("The queried domain."),
  note: z
    .string()
    .optional()
    .describe("Note regarding data source or fallback behaviour."),
  pageRank: z.number().describe("MozRank score (0–10)."),
  rank: z.string().describe("MozRank tier (Top Tier / High / Mid / Low / Minimal)."),
  domainAuthority: z
    .string()
    .describe(
      "Domain Authority note. Use get_domain_authority for the actual score.",
    ),
  totalBacklinks: z
    .number()
    .describe("Total backlink count reported by the data source."),
  referringDomainsCount: z
    .number()
    .describe("Unique referring domains in the returned set."),
  topBacklinks: z
    .array(backlinkEntrySchema)
    .describe("Sampled backlink entries."),
};

/** Convert MozRank to the rank tier string used across tools. */
function mozRankToTier(mozRank: number): string {
  if (mozRank >= 8) return "Top Tier";
  if (mozRank >= 6) return "High";
  if (mozRank >= 4) return "Mid";
  if (mozRank >= 2) return "Low";
  return "Minimal";
}

export function registerBacklinkProfileTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      description:
        "Get the full backlink profile for a domain: MozRank, total backlinks, unique referring domains, and a list of top backlinks. Uses Moz as primary source with Common Crawl as fallback.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        assertValidDomain(args.domain);
        const domain = cleanDomain(args.domain);
        const limit = args.limit ?? DEFAULT_LIMIT;
        logger.info(
          `get_backlink_profile called for: ${domain} (limit=${limit})`,
        );

        // ── Cache lookup ──────────────────────────────────────────────────────
        const cachedMetrics = getCachedDomainAuthority(domain);
        const cachedBacklinks = getCachedBacklinks(domain);
        const cacheHit = !!(cachedMetrics && cachedBacklinks);
        logQuery(domain, "get_backlink_profile", cacheHit);

        if (cacheHit) {
          logger.info(`get_backlink_profile: cache hit for ${domain}`);
          const pageRank = cachedMetrics.mozRank;
          const rank = mozRankToTier(pageRank);
          const output: BacklinkProfile & { note?: string } = {
            ...formatBacklinkProfile(domain, pageRank, rank, cachedBacklinks, {
              totalBacklinks: cachedMetrics.linksIn ?? cachedBacklinks.length,
              referringDomainsCount: cachedMetrics.rootDomainsCount ?? new Set(
                cachedBacklinks.map((b) => {
                  try { return new URL(b.url).hostname; } catch { return b.url; }
                }),
              ).size,
            }),
          };
          return {
            structuredContent: output as unknown as Record<string, unknown>,
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
          } as unknown as CallToolResult;
        }

        // ── Moz API fetch ─────────────────────────────────────────────────────
        // Fetch Moz url_metrics (for pageRank + counts) and links in parallel
        const [mozMetricsSettled, mozLinksSettled] = await Promise.allSettled([
          getMozMetrics(domain),
          getMozLinks(domain, limit),
        ]);

        if (mozMetricsSettled.status === "rejected") {
          throw mozMetricsSettled.reason instanceof Error
            ? mozMetricsSettled.reason
            : new Error(String(mozMetricsSettled.reason));
        }

        const mozMetrics = mozMetricsSettled.value;
        setCachedDomainAuthority(domain, mozMetrics);
        const pageRank = mozMetrics.mozRank;
        const rank = mozRankToTier(pageRank);

        let backlinks: BacklinkEntry[];
        let totalBacklinks: number;
        let referringDomainsCount: number;
        let note: string | undefined;

        // ── Primary: Moz /v2/links ────────────────────────────────────────────
        if (
          mozLinksSettled.status === "fulfilled" &&
          mozLinksSettled.value.length > 0
        ) {
          const mozLinks = mozLinksSettled.value;
          backlinks = mozLinks.map((link) => ({
            // source.page is the URL path without protocol; prepend https://
            url: link.source.page.startsWith("http")
              ? link.source.page
              : `https://${link.source.page}`,
            timestamp: link.date_last_seen ?? new Date().toISOString(),
            status: "N/A", // Moz does not provide per-backlink HTTP status codes
            source: "moz" as const,
          }));

          // Use url_metrics counts for accurate totals (Moz index counts)
          totalBacklinks = mozMetrics.linksIn ?? backlinks.length;
          referringDomainsCount =
            mozMetrics.rootDomainsCount ?? new Set(backlinks.map((b) => {
              try { return new URL(b.url).hostname; } catch { return b.url; }
            })).size;

          setCachedBacklinks(domain, backlinks);
          logger.info(
            `get_backlink_profile: Moz returned ${mozLinks.length} backlinks for ${domain}`,
          );
        } else {
          // ── Fallback: Common Crawl ────────────────────────────────────────
          if (mozLinksSettled.status === "fulfilled") {
            logger.info(
              `get_backlink_profile: Moz returned 0 links for ${domain}, trying Common Crawl`,
            );
          } else {
            const reason = mozLinksSettled.reason;
            logger.warn(
              `get_backlink_profile: Moz links failed for ${domain} (${reason instanceof Error ? reason.message : String(reason)}), trying Common Crawl`,
            );
          }

          const tryCrawl = async (target: string): Promise<BacklinkEntry[] | null> => {
            try {
              return await getBacklinksFromCrawl(target, limit);
            } catch {
              return null;
            }
          };

          let crawlBacklinks = await tryCrawl(domain);
          let usedRoot = false;

          if (!crawlBacklinks) {
            const isSubdomain = extractRootDomain(domain) !== domain;
            if (isSubdomain) {
              const root = extractRootDomain(domain);
              logger.info(
                `get_backlink_profile: trying root domain ${root} in Common Crawl`,
              );
              crawlBacklinks = await tryCrawl(root);
              if (crawlBacklinks) usedRoot = true;
            }
          }

          if (!crawlBacklinks) {
            // Both primary and fallback failed — return structured empty response
            const output = {
              domain,
              note: "No backlink data found. Moz returned no results and Common Crawl has no records for this domain.",
              pageRank,
              rank,
              domainAuthority: "not fetched — use get_domain_authority tool",
              totalBacklinks: 0,
              referringDomainsCount: 0,
              topBacklinks: [] as BacklinkEntry[],
            };
            return {
              structuredContent: output as unknown as Record<string, unknown>,
              content: [{ type: "text" as const, text: JSON.stringify(output) }],
            } as unknown as CallToolResult;
          }

          backlinks = crawlBacklinks;
          totalBacklinks = crawlBacklinks.length;
          referringDomainsCount = new Set(
            crawlBacklinks.map((b) => {
              try { return new URL(b.url).hostname; } catch { return b.url; }
            }),
          ).size;

          note = usedRoot
            ? "No subdomain data found; showing root domain results from Common Crawl"
            : "Moz returned no results; showing Common Crawl fallback data";
        }

        const output: BacklinkProfile & { note?: string } = {
          ...formatBacklinkProfile(domain, pageRank, rank, backlinks, {
            totalBacklinks,
            referringDomainsCount,
          }),
          note,
        };

        return {
          structuredContent: output as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
        } as unknown as CallToolResult;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`get_backlink_profile failed: ${message}`);
        const error: McpError = formatError("BACKLINK_PROFILE_ERROR", message);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(error) }],
          isError: true,
        } as unknown as CallToolResult;
      }
    },
  );
}
