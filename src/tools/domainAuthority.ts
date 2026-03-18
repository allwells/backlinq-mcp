// Tool: get_domain_authority
// Adapter: Moz url_metrics (single call — no OpenPageRank dependency)

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DomainAuthorityOutput, McpError } from "../types/index.js";
import { getMozMetrics } from "../adapters/moz.js";
import { cleanDomain, assertValidDomain } from "../utils/validator.js";
import { formatError } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";
import {
  getCachedDomainAuthority,
  getStaleCachedDomainAuthority,
  setCachedDomainAuthority,
  logQuery,
} from "../database.js";
import { isApproachingLimit } from "../rateLimit.js";

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
      "MozRank score (0-10), a logarithmic measure of link authority equivalent to PageRank.",
    ),
  rank: z
    .string()
    .describe(
      "Rank tier derived from MozRank (e.g. 'Top Tier', 'High', 'Mid', 'Low').",
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

/** Converts a MozRank 0-10 score to a descriptive rank tier string. */
function mozRankToTier(mozRank: number): string {
  if (mozRank >= 8) return "Top Tier";
  if (mozRank >= 6) return "High";
  if (mozRank >= 4) return "Mid";
  if (mozRank >= 2) return "Low";
  return "Minimal";
}

export function registerDomainAuthorityTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      description:
        "Get domain authority score, MozRank, spam score, and inbound link count for a domain. Uses Moz as the sole data source.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        assertValidDomain(args.domain);
        const domain = cleanDomain(args.domain);
        logger.info(`get_domain_authority called for: ${domain}`);

        // ── Cache lookup ──────────────────────────────────────────────────────
        const cached = getCachedDomainAuthority(domain);
        logQuery(domain, "get_domain_authority", !!cached);
        if (cached) {
          logger.info(`get_domain_authority: cache hit for ${domain}`);
          const output: DomainAuthorityOutput = {
            domain,
            pageRank: Number(cached.mozRank),
            rank: mozRankToTier(cached.mozRank),
            domainAuthority: Number(cached.domainAuthority),
            spamScore: Number(cached.spamScore),
            linksIn: cached.linksIn !== undefined ? Number(cached.linksIn) : undefined,
          };
          return {
            structuredContent: output as unknown as Record<string, unknown>,
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
          } as unknown as CallToolResult;
        }

        // ── Rate limit guard ──────────────────────────────────────────────────
        if (isApproachingLimit()) {
          const stale = getStaleCachedDomainAuthority(domain);
          if (stale) {
            logger.warn(`get_domain_authority: approaching rate limit, serving stale cache for ${domain}`);
            const output = {
              domain,
              pageRank: Number(stale.mozRank),
              rank: mozRankToTier(stale.mozRank),
              domainAuthority: Number(stale.domainAuthority),
              spamScore: Number(stale.spamScore),
              linksIn: stale.linksIn !== undefined ? Number(stale.linksIn) : undefined,
              note: "Data served from cache due to rate limit management — may be up to 24 hours old.",
            };
            return {
              structuredContent: output as unknown as Record<string, unknown>,
              content: [{ type: "text" as const, text: JSON.stringify(output) }],
            } as unknown as CallToolResult;
          }
        }

        // ── Moz API fetch ─────────────────────────────────────────────────────
        let mozResult;
        try {
          mozResult = await getMozMetrics(domain);
          setCachedDomainAuthority(domain, mozResult);
        } catch (fetchErr: unknown) {
          // Moz unavailable — serve stale cache data with a warning note if available
          const stale = getStaleCachedDomainAuthority(domain);
          if (stale) {
            logger.warn(`get_domain_authority: Moz failed, serving stale cache for ${domain}`);
            const output = {
              domain,
              pageRank: Number(stale.mozRank),
              rank: mozRankToTier(stale.mozRank),
              domainAuthority: Number(stale.domainAuthority),
              spamScore: Number(stale.spamScore),
              linksIn: stale.linksIn !== undefined ? Number(stale.linksIn) : undefined,
              note: "Data served from stale cache — Moz API temporarily unavailable.",
            };
            return {
              structuredContent: output as unknown as Record<string, unknown>,
              content: [{ type: "text" as const, text: JSON.stringify(output) }],
            } as unknown as CallToolResult;
          }
          throw fetchErr;
        }

        const output: DomainAuthorityOutput = {
          domain,
          pageRank: Number(mozResult.mozRank),
          rank: mozRankToTier(mozResult.mozRank),
          domainAuthority: Number(mozResult.domainAuthority),
          spamScore: Number(mozResult.spamScore),
          linksIn:
            mozResult.linksIn !== undefined ? Number(mozResult.linksIn) : undefined,
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
