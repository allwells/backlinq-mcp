// Tool: get_backlink_profile
// Adapters: openPageRank + commonCrawl (parallel)

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BacklinkProfile, McpError } from "../types/index.js";
import { getDomainPageRank } from "../adapters/openPageRank.js";
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
  url: z.string().describe("URL of the crawled page that links to the domain."),
  timestamp: z.string().describe("Crawl timestamp in YYYYMMDDHHmmss format."),
  status: z.string().describe("HTTP status code of the crawled page."),
  source: z.literal("commoncrawl"),
});

const outputSchema = {
  domain: z.string().describe("The queried domain."),
  note: z
    .string()
    .optional()
    .describe("Note regarding subdomains or fallback logic."),
  pageRank: z.number().describe("Open PageRank score."),
  rank: z.string().describe("Global rank position from Open PageRank."),
  domainAuthority: z
    .string()
    .describe(
      "Domain Authority note. Use get_domain_authority for the actual score.",
    ),
  totalBacklinks: z
    .number()
    .describe("Number of backlink records returned from Common Crawl."),
  referringDomainsCount: z
    .number()
    .describe("Count of unique referring domains in the returned backlinks."),
  topBacklinks: z
    .array(backlinkEntrySchema)
    .describe("List of backlink entries from the Common Crawl index."),
};

export function registerBacklinkProfileTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      description:
        "Get the full backlink profile for a domain: page rank, total backlinks found, unique referring domains, and a list of top backlinks from the Common Crawl index.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      let rankResult;
      try {
        assertValidDomain(args.domain); // Validate raw input FIRST, before any cleaning
        const domain = cleanDomain(args.domain);
        const limit = args.limit ?? DEFAULT_LIMIT;
        logger.info(
          `get_backlink_profile called for: ${domain} (limit=${limit})`,
        );

        rankResult = await getDomainPageRank(domain);
        let backlinks;
        let note: string | undefined;

        try {
          backlinks = await getBacklinksFromCrawl(domain, limit);
        } catch (crawlErr: any) {
          const isSubdomain = extractRootDomain(domain) !== domain;
          if (isSubdomain) {
            const root = extractRootDomain(domain);
            logger.info(
              `No backlinks found for subdomain ${domain}. Falling back to root domain: ${root}`,
            );
            try {
              backlinks = await getBacklinksFromCrawl(root, limit);
              note = "No subdomain data found, showing root domain results";
            } catch (fallbackErr: any) {
              // Even the root is empty
              throw new Error(
                `Common Crawl found no backlink data for ${domain} or root domain ${root}. ` +
                  `However, Open PageRank data is available: PR ${rankResult.pageRank} (Rank: ${rankResult.rank}). ` +
                  `Original Crawl Error: ${crawlErr.message}`,
              );
            }
          } else {
            throw new Error(
              `Common Crawl found no backlink data for ${domain}. ` +
                `However, Open PageRank data is available: PR ${rankResult.pageRank} (Rank: ${rankResult.rank}). ` +
                `Original Crawl Error: ${crawlErr.message}`,
            );
          }
        }

        const output: BacklinkProfile & { note?: string } = {
          ...formatBacklinkProfile(domain, rankResult, backlinks),
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
