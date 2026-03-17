// Tool: compare_domains
// Adapter: Moz url_metrics with batch query (both domains in a single API call)
// No OpenPageRank dependency — MozRank replaces it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CompareDomainsOutput, McpError } from "../types/index.js";
import { getMozMetrics } from "../adapters/moz.js";
import { cleanDomain, assertValidDomain } from "../utils/validator.js";
import { formatDomainComparison, formatError } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";
import {
  getCachedDomainAuthority,
  setCachedDomainAuthority,
  logQuery,
} from "../database.js";

const TOOL_NAME = "compare_domains" as const;

const domainMetricsSchema = z.object({
  domain: z.string(),
  pageRank: z.number().describe("MozRank (0-10)."),
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
        "Compare two domains side by side: MozRank, domain authority, spam score, and total inbound links. Returns a winner and human-readable summary. Uses a single batched Moz API call.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        assertValidDomain(args.domainA);
        assertValidDomain(args.domainB);
        const domainA = cleanDomain(args.domainA);
        const domainB = cleanDomain(args.domainB);
        logger.info(`compare_domains called: ${domainA} vs ${domainB}`);

        // ── Cache lookup ──────────────────────────────────────────────────────
        let mozA = getCachedDomainAuthority(domainA);
        let mozB = getCachedDomainAuthority(domainB);
        logQuery(domainA, "compare_domains", !!mozA);
        logQuery(domainB, "compare_domains", !!mozB);

        if (!mozA || !mozB) {
          const needA = !mozA;
          const needB = !mozB;

          // Batch if both are missing, single calls otherwise
          if (needA && needB) {
            const results = await getMozMetrics([domainA, domainB]);
            mozA = results[0]!;
            mozB = results[1]!;
          } else if (needA) {
            mozA = await getMozMetrics(domainA);
          } else {
            mozB = await getMozMetrics(domainB);
          }

          if (!mozA || !mozB) {
            throw new Error(
              `[Moz] url_metrics returned fewer results than expected for batch query`,
            );
          }

          if (needA) setCachedDomainAuthority(domainA, mozA);
          if (needB) setCachedDomainAuthority(domainB, mozB);
        }

        const comparison = formatDomainComparison(domainA, mozA, domainB, mozB);
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
