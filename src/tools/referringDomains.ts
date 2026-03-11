// Tool: get_referring_domains
// Primary: DataForSEO referring domains API
// Fallback: Common Crawl CDX index (deduplication of backlink URLs)

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  ReferringDomainsOutput,
  ReferringDomain,
  McpError,
} from "../types/index.js";
import { getReferringDomains as getDataForSeoReferringDomains } from "../adapters/dataForSeo.js";
import { getBacklinksFromCrawl } from "../adapters/commonCrawl.js";
import {
  cleanDomain,
  assertValidDomain,
  extractRootDomain,
} from "../utils/validator.js";
import { formatError } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";

const TOOL_NAME = "get_referring_domains" as const;
const CRAWL_FETCH_LIMIT = 200; // raw records to fetch from CommonCrawl before dedup
const MAX_LIMIT = 100; // max unique domains to return

function extractReferringDomainsFromCrawl(
  backlinks: ReadonlyArray<{ url: string; timestamp: string; status: string }>,
  limit: number,
): readonly ReferringDomain[] {
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

const inputSchema = {
  domain: z
    .string()
    .describe("The domain to look up referring domains for, e.g. example.com"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(
      `Max number of unique referring domains to return (default ${MAX_LIMIT})`,
    ),
};

const outputSchema = {
  domain: z.string().describe("The queried domain."),
  note: z
    .string()
    .optional()
    .describe("Note regarding data source or fallback behaviour."),
  totalFound: z.number().describe("Number of unique referring domains found."),
  referringDomains: z
    .array(
      z.object({
        domain: z
          .string()
          .describe("Root domain of the referring site (www stripped)."),
        exampleUrl: z
          .string()
          .describe("An example URL from this referring domain."),
        lastSeen: z
          .string()
          .describe("Last crawl or last-seen timestamp."),
        source: z
          .enum(["commoncrawl", "dataforseo"])
          .describe("Data source that provided this entry."),
        backlinkCount: z
          .number()
          .optional()
          .describe("Total backlinks from this domain (DataForSEO only)."),
        dofollowCount: z
          .number()
          .optional()
          .describe("Dofollow backlinks from this domain (DataForSEO only)."),
      }),
    )
    .describe("List of unique referring domains."),
};

export function registerReferringDomainsTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      description:
        "List unique referring domains that link to a given domain. Uses DataForSEO as primary source with Common Crawl as fallback. Returns domain names, example URL, last-seen timestamp, and (from DataForSEO) backlink counts.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        assertValidDomain(args.domain);
        const domain = cleanDomain(args.domain);
        const limit = args.limit ?? MAX_LIMIT;
        logger.info(
          `get_referring_domains called for: ${domain} (limit=${limit})`,
        );

        let referringDomains: readonly ReferringDomain[];
        let note: string | undefined;

        // ── Primary: DataForSEO ──────────────────────────────────────────────
        const dfsResult = await getDataForSeoReferringDomains(
          domain,
          limit,
        ).catch((err: unknown) => {
          logger.warn(
            `get_referring_domains: DataForSEO failed for ${domain} (${err instanceof Error ? err.message : String(err)}), trying Common Crawl`,
          );
          return null;
        });

        if (dfsResult && dfsResult.referringDomains.length > 0) {
          referringDomains = dfsResult.referringDomains.map((d) => ({
            domain: d.domain,
            exampleUrl: d.exampleUrl,
            lastSeen: d.lastSeen,
            source: "dataforseo" as const,
            backlinkCount: d.backlinkCount,
            dofollowCount: d.dofollowCount,
          }));
          logger.info(
            `get_referring_domains: DataForSEO found ${referringDomains.length} referring domains for ${domain}`,
          );
        } else {
          // ── Fallback: Common Crawl ─────────────────────────────────────────
          if (dfsResult) {
            logger.info(
              `get_referring_domains: DataForSEO returned 0 results for ${domain}, trying Common Crawl`,
            );
          }

          const tryCrawl = async (
            target: string,
          ): Promise<readonly ReferringDomain[] | null> => {
            try {
              const backlinks = await getBacklinksFromCrawl(
                target,
                CRAWL_FETCH_LIMIT,
              );
              return extractReferringDomainsFromCrawl(backlinks, limit);
            } catch {
              return null;
            }
          };

          let crawlResult = await tryCrawl(domain);
          let usedRoot = false;

          if (!crawlResult) {
            const isSubdomain = extractRootDomain(domain) !== domain;
            if (isSubdomain) {
              const root = extractRootDomain(domain);
              logger.info(
                `get_referring_domains: trying root domain ${root} in Common Crawl`,
              );
              crawlResult = await tryCrawl(root);
              if (crawlResult) usedRoot = true;
            }
          }

          if (!crawlResult) {
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

          referringDomains = crawlResult;

          if (usedRoot) {
            note = "No subdomain data found, showing root domain results";
          } else if (dfsResult) {
            note = "DataForSEO returned no results; showing Common Crawl data";
          }
        }

        const output: ReferringDomainsOutput & { note?: string } = {
          domain,
          totalFound: referringDomains.length,
          referringDomains,
          note,
        };

        return {
          structuredContent: output as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
        } as unknown as CallToolResult;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`get_referring_domains failed: ${message}`);
        const error: McpError = formatError("REFERRING_DOMAINS_ERROR", message);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(error) }],
          isError: true,
        } as unknown as CallToolResult;
      }
    },
  );
}
