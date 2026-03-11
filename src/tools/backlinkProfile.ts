// Tool: get_backlink_profile
// Primary: DataForSEO backlinks API
// Fallback: Common Crawl CDX index (for domains not in DataForSEO)

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BacklinkProfile, BacklinkEntry, McpError } from "../types/index.js";
import { getDomainPageRank } from "../adapters/openPageRank.js";
import { getBacklinkProfile as getDataForSeoProfile } from "../adapters/dataForSeo.js";
import { getBacklinksFromCrawl } from "../adapters/commonCrawl.js";
import {
  cleanDomain,
  assertValidDomain,
  extractRootDomain,
} from "../utils/validator.js";
import { formatBacklinkProfile, formatError } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";

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
  timestamp: z.string().describe("Crawl or last-seen timestamp."),
  status: z
    .string()
    .describe("HTTP status code, or '200' when unavailable from source."),
  source: z
    .enum(["commoncrawl", "dataforseo"])
    .describe("Data source that provided this backlink."),
});

const outputSchema = {
  domain: z.string().describe("The queried domain."),
  note: z
    .string()
    .optional()
    .describe("Note regarding data source or fallback behaviour."),
  pageRank: z.number().describe("Open PageRank score (0–10)."),
  rank: z.string().describe("Global rank position from Open PageRank."),
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

export function registerBacklinkProfileTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      description:
        "Get the full backlink profile for a domain: page rank, total backlinks, unique referring domains, and a list of top backlinks. Uses DataForSEO as primary source with Common Crawl as fallback.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        assertValidDomain(args.domain);
        const domain = cleanDomain(args.domain);
        const limit = args.limit ?? DEFAULT_LIMIT;
        logger.info(`get_backlink_profile called for: ${domain} (limit=${limit})`);

        // Fire PageRank and DataForSEO in parallel
        const [rankSettled, dfsSettled] = await Promise.allSettled([
          getDomainPageRank(domain),
          getDataForSeoProfile(domain, limit),
        ]);

        if (rankSettled.status === "rejected") {
          throw rankSettled.reason instanceof Error
            ? rankSettled.reason
            : new Error(String(rankSettled.reason));
        }

        const rankResult = rankSettled.value;
        let backlinks: BacklinkEntry[];
        let totalBacklinks: number;
        let referringDomainsCount: number;
        let note: string | undefined;

        // ── Primary: DataForSEO ──────────────────────────────────────────────
        if (
          dfsSettled.status === "fulfilled" &&
          dfsSettled.value.topBacklinks.length > 0
        ) {
          const dfs = dfsSettled.value;
          backlinks = dfs.topBacklinks.map((b) => ({
            url: b.url,
            timestamp: b.lastSeen,
            status: "200",
            source: "dataforseo" as const,
          }));
          totalBacklinks = dfs.totalBacklinks;
          referringDomainsCount = dfs.referringDomains;
          logger.info(
            `get_backlink_profile: DataForSEO found ${totalBacklinks} total backlinks for ${domain}`,
          );
        } else {
          // ── Fallback: Common Crawl ─────────────────────────────────────────
          if (dfsSettled.status === "fulfilled") {
            logger.info(
              `get_backlink_profile: DataForSEO returned 0 results for ${domain}, trying Common Crawl`,
            );
          } else {
            const reason = dfsSettled.reason;
            logger.warn(
              `get_backlink_profile: DataForSEO failed for ${domain} (${reason instanceof Error ? reason.message : String(reason)}), trying Common Crawl`,
            );
          }

          // Helper — attempt a crawl fetch, return null on failure
          const tryCrawl = async (
            target: string,
          ): Promise<BacklinkEntry[] | null> => {
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
            const error = formatError(
              "NO_BACKLINK_DATA",
              "No backlink records found for this domain in available data sources.",
            );
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(error) },
              ],
              isError: true,
            } as unknown as CallToolResult;
          }

          backlinks = crawlBacklinks;
          totalBacklinks = crawlBacklinks.length;
          referringDomainsCount = new Set(
            crawlBacklinks.map((b) => {
              try {
                return new URL(b.url).hostname;
              } catch {
                return b.url;
              }
            }),
          ).size;

          if (usedRoot) {
            note = "No subdomain data found, showing root domain results";
          } else if (dfsSettled.status === "fulfilled") {
            note = "DataForSEO returned no results; showing Common Crawl data";
          }
        }

        const output: BacklinkProfile & { note?: string } = {
          ...formatBacklinkProfile(domain, rankResult, backlinks, {
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
