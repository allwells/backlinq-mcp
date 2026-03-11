// Tool: get_domain_authority
// Adapters: openPageRank + moz (parallel)

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DomainAuthorityOutput, McpError } from "../types/index.js";
import { getDomainPageRank } from "../adapters/openPageRank.js";
import { getMozMetrics } from "../adapters/moz.js";
import { cleanDomain, assertValidDomain } from "../utils/validator.js";
import { formatError } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";

const TOOL_NAME = "get_domain_authority" as const;

const inputSchema = {
  domain: z
    .string()
    .describe(
      "The domain to evaluate, e.g. example.com. Protocols and trailing slashes are stripped automatically.",
    ),
};

const outputSchema = {
  domain: z.string().describe("The queried domain."),
  pageRank: z
    .number()
    .describe(
      "Open PageRank score (0-10), a logarithmic measure of link authority.",
    ),
  rank: z
    .string()
    .describe(
      "Global rank position string from Open PageRank (lower is better).",
    ),
  domainAuthority: z
    .number()
    .describe(
      "Moz Domain Authority score (1-100). Higher is more authoritative.",
    ),
  spamScore: z
    .number()
    .describe(
      "Moz Spam Score (0-17). Higher means greater likelihood of being a spammy domain.",
    ),
  linksIn: z
    .number()
    .optional()
    .describe("Total inbound links to the domain as reported by Moz."),
};

export function registerDomainAuthorityTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      description:
        "Get domain authority score, page rank, spam score, and inbound link count for a domain. Uses Open PageRank and Moz data sources.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        assertValidDomain(args.domain); // Validate raw input FIRST, before any cleaning
        const domain = cleanDomain(args.domain);
        logger.info(`get_domain_authority called for: ${domain}`);

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
          linksIn:
            mozResult.linksIn !== undefined
              ? Number(mozResult.linksIn)
              : undefined,
        };

        return {
          structuredContent: output as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
        } as unknown as CallToolResult;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`get_domain_authority failed: ${message}`);
        const error: McpError = formatError("DOMAIN_AUTHORITY_ERROR", message);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(error) }],
          isError: true,
        } as unknown as CallToolResult;
      }
    },
  );
}
