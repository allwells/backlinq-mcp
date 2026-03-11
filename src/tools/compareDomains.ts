// Tool: compare_domains
// Adapters: openPageRank + moz for BOTH domains -- all 4 calls in parallel

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CompareDomainsOutput, McpError } from "../types/index.js";
import { getDomainPageRank } from "../adapters/openPageRank.js";
import { getMozMetrics } from "../adapters/moz.js";
import { cleanDomain, assertValidDomain } from "../utils/validator.js";
import { formatDomainComparison, formatError } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";

const TOOL_NAME = "compare_domains" as const;

const domainMetricsSchema = z.object({
  domain: z.string(),
  pageRank: z.number(),
  domainAuthority: z.number(),
  spamScore: z.number(),
  linksIn: z.number().optional(),
});

const inputSchema = {
  domainA: z.string().describe("First domain to compare, e.g. vercel.com"),
  domainB: z.string().describe("Second domain to compare, e.g. netlify.com"),
};

const outputSchema = {
  comparison: z.object({
    domainA: domainMetricsSchema,
    domainB: domainMetricsSchema,
    winner: z
      .string()
      .describe(
        "The domain with the stronger overall backlink profile, or 'tie' if equal.",
      ),
    summary: z
      .string()
      .describe("Human-readable summary of which domain won and why."),
  }),
};

export function registerCompareDomainsTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      description:
        "Compare two domains side by side: page rank, domain authority, spam score, and total inbound links. Returns a winner and human-readable summary.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        assertValidDomain(args.domainA); // Validate raw input FIRST, before any cleaning
        assertValidDomain(args.domainB);
        const domainA = cleanDomain(args.domainA);
        const domainB = cleanDomain(args.domainB);
        logger.info(`compare_domains called: ${domainA} vs ${domainB}`);

        // All 4 adapter calls are independent -- fire them all in parallel
        const [rankA, mozA, rankB, mozB] = await Promise.all([
          getDomainPageRank(domainA),
          getMozMetrics(domainA),
          getDomainPageRank(domainB),
          getMozMetrics(domainB),
        ]);

        const comparison = formatDomainComparison(
          domainA,
          { rankResult: rankA, mozMetrics: mozA },
          domainB,
          { rankResult: rankB, mozMetrics: mozB },
        );

        const output: CompareDomainsOutput = { comparison };

        return {
          structuredContent: output as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
        } as unknown as CallToolResult;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`compare_domains failed: ${message}`);
        const error: McpError = formatError("COMPARE_DOMAINS_ERROR", message);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(error) }],
          isError: true,
        } as unknown as CallToolResult;
      }
    },
  );
}
