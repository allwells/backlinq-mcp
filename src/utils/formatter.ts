// Response formatting helpers — pure functions that combine adapter results into tool outputs

import type {
  BacklinkEntry,
  BacklinkProfile,
  DomainComparison,
  McpError,
  MozDomainMetrics,
} from "../types/index.js";

// ─── Adapter result combiners ─────────────────────────────────────────────────

const DA_NOT_FETCHED_MSG =
  "not fetched — use get_domain_authority tool" as const;

/**
 * Combines Moz metrics + backlink records into a BacklinkProfile.
 * Called by the get_backlink_profile tool.
 */
export function formatBacklinkProfile(
  domain: string,
  pageRank: number,
  rank: string,
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
    pageRank,
    rank,
    domainAuthority: DA_NOT_FETCHED_MSG,
    totalBacklinks: counts?.totalBacklinks ?? backlinks.length,
    referringDomainsCount: counts?.referringDomainsCount ?? uniqueDomains.size,
    topBacklinks: backlinks,
  };
}

/**
 * Builds a side-by-side DomainComparison from two sets of Moz results.
 * Called by the compare_domains tool.
 */
export function formatDomainComparison(
  domainA: string,
  metricsA: MozDomainMetrics,
  domainB: string,
  metricsB: MozDomainMetrics,
): DomainComparison {
  const scoreA = metricsA.mozRank + metricsA.domainAuthority / 10;
  const scoreB = metricsB.mozRank + metricsB.domainAuthority / 10;

  const winner = scoreA > scoreB ? domainA : scoreB > scoreA ? domainB : "tie";

  const summary =
    winner === "tie"
      ? `${domainA} and ${domainB} are evenly matched.`
      : `${winner} has a stronger overall backlink profile (MozRank + Domain Authority).`;

  return {
    domainA: {
      domain: domainA,
      pageRank: Number(metricsA.mozRank),
      domainAuthority: Number(metricsA.domainAuthority),
      spamScore: Number(metricsA.spamScore),
      linksIn: metricsA.linksIn !== undefined ? Number(metricsA.linksIn) : undefined,
    },
    domainB: {
      domain: domainB,
      pageRank: Number(metricsB.mozRank),
      domainAuthority: Number(metricsB.domainAuthority),
      spamScore: Number(metricsB.spamScore),
      linksIn: metricsB.linksIn !== undefined ? Number(metricsB.linksIn) : undefined,
    },
    winner,
    summary,
  };
}

// ─── Error helpers ────────────────────────────────────────────────────────────

export function formatError(code: string, message: string): McpError {
  return { error: true, code, message };
}
