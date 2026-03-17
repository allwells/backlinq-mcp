// Tool: get_referring_domains
// Primary: Moz /v2/linking_root_domains
// Fallback: Common Crawl CDX index (cached 24h, subdomains normalised to root)

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ReferringDomainsOutput, ReferringDomain, McpError } from "../types/index.js";
import { getMozLinkingRootDomains } from "../adapters/moz.js";
import {
  getBacklinksFromCrawl,
  normaliseToRootDomain,
} from "../adapters/commonCrawl.js";
import {
  cleanDomain,
  assertValidDomain,
  extractRootDomain,
} from "../utils/validator.js";
import { formatError } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";
import {
  getCachedReferringDomains,
  setCachedReferringDomains,
  logQuery,
} from "../database.js";

const TOOL_NAME = "get_referring_domains" as const;
const CRAWL_FETCH_LIMIT = 200; // raw records to fetch before dedup
const MAX_LIMIT = 100;

/** Current date as ISO string — used as lastSeen proxy for Moz results. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Deduplicates Common Crawl backlink records into referring root domains.
 * Normalises subdomains (blog.example.com → example.com) so all links from
 * the same registrable domain count as one referring domain.
 */
function extractReferringDomainsFromCrawl(
  backlinks: ReadonlyArray<{ url: string; timestamp: string; status: string }>,
  limit: number,
): readonly ReferringDomain[] {
  const seen = new Map<string, ReferringDomain>();

  for (const entry of backlinks) {
    if (seen.size >= limit) break;
    try {
      const root = normaliseToRootDomain(new URL(entry.url).hostname);
      if (!seen.has(root)) {
        seen.set(root, {
          domain: root,
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
    .describe(`Max number of unique referring domains to return (default ${MAX_LIMIT})`),
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
          .describe("An example URL or root URL from this referring domain."),
        lastSeen: z
          .string()
          .describe("Last crawl or index date (ISO). Moz results use today's date as proxy."),
        source: z
          .enum(["commoncrawl", "dataforseo", "moz"])
          .describe("Data source that provided this entry."),
        backlinkCount: z
          .number()
          .optional()
          .describe("Total linking pages from this domain (Moz only)."),
        dofollowCount: z
          .number()
          .optional()
          .describe("Follow links from this domain (Moz: linking_pages − nofollow_pages)."),
      }),
    )
    .describe("List of unique referring domains."),
};

export function registerReferringDomainsTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      description:
        "List unique referring domains that link to a given domain. Uses Moz as primary source with Common Crawl as fallback. Returns domain names, an example URL, last-seen date, and (from Moz) link counts.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        assertValidDomain(args.domain);
        const domain = cleanDomain(args.domain);
        const limit = args.limit ?? MAX_LIMIT;
        logger.info(`get_referring_domains called for: ${domain} (limit=${limit})`);

        // ── Cache lookup ──────────────────────────────────────────────────────
        const cachedDomains = getCachedReferringDomains(domain);
        logQuery(domain, "get_referring_domains", !!cachedDomains);
        if (cachedDomains) {
          logger.info(`get_referring_domains: cache hit for ${domain}`);
          const output: ReferringDomainsOutput = {
            domain,
            totalFound: cachedDomains.length,
            referringDomains: cachedDomains,
          };
          return {
            structuredContent: output as unknown as Record<string, unknown>,
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
          } as unknown as CallToolResult;
        }

        let referringDomains: readonly ReferringDomain[];
        let note: string | undefined;

        // ── Primary: Moz /v2/linking_root_domains ─────────────────────────────
        const mozResult = await getMozLinkingRootDomains(domain, limit).catch(
          (err: unknown) => {
            logger.warn(
              `get_referring_domains: Moz failed for ${domain} (${err instanceof Error ? err.message : String(err)}), trying Common Crawl`,
            );
            return null;
          },
        );

        if (mozResult && mozResult.length > 0) {
          const today = nowIso();
          referringDomains = mozResult.map((d) => {
            const pages = d.to_target?.pages;
            const nofollowPages = d.to_target?.nofollow_pages;
            const dofollowCount =
              pages !== undefined && nofollowPages !== undefined
                ? Math.max(0, pages - nofollowPages)
                : undefined;
            return {
              domain: d.root_domain,
              exampleUrl: `https://${d.root_domain}/`,
              lastSeen: today,
              source: "moz" as const,
              backlinkCount: pages,
              dofollowCount,
            };
          });
          setCachedReferringDomains(domain, referringDomains);
          logger.info(
            `get_referring_domains: Moz returned ${referringDomains.length} referring domains for ${domain}`,
          );
        } else {
          // ── Fallback: Common Crawl ────────────────────────────────────────
          if (mozResult) {
            logger.info(
              `get_referring_domains: Moz returned 0 results for ${domain}, trying Common Crawl`,
            );
          }

          const tryCrawl = async (
            target: string,
          ): Promise<readonly ReferringDomain[] | null> => {
            try {
              const backlinks = await getBacklinksFromCrawl(target, CRAWL_FETCH_LIMIT);
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
            // Both primary and fallback failed — return structured empty response
            const output: ReferringDomainsOutput & { note: string } = {
              domain,
              note: "No referring domain data found. Moz returned no results and Common Crawl has no records for this domain.",
              totalFound: 0,
              referringDomains: [],
            };
            return {
              structuredContent: output as unknown as Record<string, unknown>,
              content: [{ type: "text" as const, text: JSON.stringify(output) }],
            } as unknown as CallToolResult;
          }

          referringDomains = crawlResult;

          note = usedRoot
            ? "No subdomain data found; showing root domain results from Common Crawl"
            : "Moz returned no results; showing Common Crawl fallback data";
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
