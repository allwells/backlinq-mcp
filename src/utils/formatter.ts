// Response formatting helpers — pure functions that combine adapter results into tool outputs

import type {
  BacklinkEntry,
  BacklinkProfile,
  DomainComparison,
  DomainRankResult,
  McpError,
  MozDomainMetrics,
} from "../types/index.js";

// ─── Adapter result combiners ─────────────────────────────────────────────────

/**
 * Combines Open PageRank + Common Crawl results into a BacklinkProfile.
 * Called by the get_backlink_profile tool.
 */
const DA_NOT_FETCHED_MSG =
  "not fetched — use get_domain_authority tool" as const;

export function formatBacklinkProfile(
  domain: string,
  rankResult: DomainRankResult,
  backlinks: readonly BacklinkEntry[],
  counts?: { totalBacklinks?: number; referringDomainsCount?: number },
): BacklinkProfile {
  const uniqueDomains = new Set(
    backlinks.map((b) => {
      try {
        return new URL(b.url).hostname;
      } catch {
        return b.url;
      }
    }),
  );

  return {
    domain,
    pageRank:
      typeof rankResult.pageRank === "object" && rankResult.pageRank !== null
        ? Number((rankResult.pageRank as any).value || rankResult.pageRank)
        : Number(rankResult.pageRank),
    rank:
      typeof rankResult.rank === "object" && rankResult.rank !== null
        ? String((rankResult.rank as any).value || rankResult.rank)
        : String(rankResult.rank),
    domainAuthority: DA_NOT_FETCHED_MSG,
    totalBacklinks: counts?.totalBacklinks ?? backlinks.length,
    referringDomainsCount: counts?.referringDomainsCount ?? uniqueDomains.size,
    topBacklinks: backlinks,
  };
}

/**
 * Builds a side-by-side DomainComparison from two sets of adapter results.
 * Called by the compare_domains tool.
 */
export function formatDomainComparison(
  domainA: string,
  metricsA: { rankResult: DomainRankResult; mozMetrics: MozDomainMetrics },
  domainB: string,
  metricsB: { rankResult: DomainRankResult; mozMetrics: MozDomainMetrics },
): DomainComparison {
  const scoreA =
    metricsA.rankResult.pageRank + metricsA.mozMetrics.domainAuthority / 10;
  const scoreB =
    metricsB.rankResult.pageRank + metricsB.mozMetrics.domainAuthority / 10;

  const winner = scoreA > scoreB ? domainA : scoreB > scoreA ? domainB : "tie";

  const summary =
    winner === "tie"
      ? `${domainA} and ${domainB} are evenly matched.`
      : `${winner} has a stronger overall backlink profile (PageRank + Domain Authority).`;

  return {
    domainA: {
      domain: domainA,
      pageRank: Number(metricsA.rankResult.pageRank),
      domainAuthority: Number(metricsA.mozMetrics.domainAuthority),
      spamScore: Number(metricsA.mozMetrics.spamScore),
      linksIn:
        metricsA.mozMetrics.linksIn !== undefined
          ? Number(metricsA.mozMetrics.linksIn)
          : undefined,
    },
    domainB: {
      domain: domainB,
      pageRank: Number(metricsB.rankResult.pageRank),
      domainAuthority: Number(metricsB.mozMetrics.domainAuthority),
      spamScore: Number(metricsB.mozMetrics.spamScore),
      linksIn:
        metricsB.mozMetrics.linksIn !== undefined
          ? Number(metricsB.mozMetrics.linksIn)
          : undefined,
    },
    winner,
    summary,
  };
}

// ─── Error helpers ────────────────────────────────────────────────────────────

export function formatError(code: string, message: string): McpError {
  return { error: true, code, message };
}
