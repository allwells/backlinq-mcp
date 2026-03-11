// Tool: get_referring_domains
// Adapter: commonCrawl only -- extracts unique root domains from backlink URLs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  ReferringDomainsOutput,
  ReferringDomain,
  McpError,
} from "../types/index.js";
import { getBacklinksFromCrawl } from "../adapters/commonCrawl.js";
import {
  cleanDomain,
  assertValidDomain,
  extractRootDomain,
} from "../utils/validator.js";
import { formatError } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";

const TOOL_NAME = "get_referring_domains" as const;
const RAW_FETCH_LIMIT = 200; // fetch more raw records so we get more unique domains after dedup
const MAX_LIMIT = 100; // max unique domains to return

function extractReferringDomains(
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
    .describe("Note regarding subdomains or fallback logic."),
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
          .describe("Last crawl timestamp in YYYYMMDDHHmmss format."),
        source: z.literal("commoncrawl"),
      }),
    )
    .describe("List of unique referring domains."),
};

export function registerReferringDomainsTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      description:
        "List unique referring domains that link to a given domain, discovered via the Common Crawl index. Returns domain names, an example URL, and last-seen timestamp.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        assertValidDomain(args.domain); // Validate raw input FIRST, before any cleaning
        const domain = cleanDomain(args.domain);
        const limit = args.limit ?? MAX_LIMIT;
        logger.info(
          `get_referring_domains called for: ${domain} (limit=${limit})`,
        );

        let rawBacklinks;
        let note: string | undefined;

        try {
          rawBacklinks = await getBacklinksFromCrawl(domain, RAW_FETCH_LIMIT);
        } catch (crawlErr: any) {
          const isSubdomain = extractRootDomain(domain) !== domain;
          if (isSubdomain) {
            const root = extractRootDomain(domain);
            logger.info(
              `No referring domains found for subdomain ${domain}. Falling back to root domain: ${root}`,
            );
            try {
              rawBacklinks = await getBacklinksFromCrawl(root, RAW_FETCH_LIMIT);
              note = "No subdomain data found, showing root domain results";
            } catch (fallbackErr: any) {
              throw new Error(
                `Common Crawl found no referring domains for ${domain} or root domain ${root}. Original Error: ${crawlErr.message}`,
              );
            }
          } else {
            throw new Error(
              `Common Crawl found no referring domains for ${domain}. Original Error: ${crawlErr.message}`,
            );
          }
        }

        const referringDomains = extractReferringDomains(rawBacklinks, limit);

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
