// All shared TypeScript types and interfaces for Backlinq
// All types live here — never inline in adapter or tool files

// ─── Generic Result wrapper ──────────────────────────────────────────────────

export interface SuccessResult<T> {
  readonly success: true;
  readonly data: T;
}

export interface ErrorResult {
  readonly success: false;
  readonly error: true;
  readonly code: string;
  readonly message: string;
}

export type Result<T> = SuccessResult<T> | ErrorResult;

// ─── Adapter Error ─────────────────────────────────────────────────────────────

export interface AdapterError {
  readonly error: true;
  readonly code: string;
  readonly message: string;
}

// ─── MCP Structured Error (returned to MCP client) ───────────────────────────

export interface McpError {
  readonly error: true;
  readonly code: string;
  readonly message: string;
}

// ─── Open PageRank ────────────────────────────────────────────────────────────

export interface OpenPageRankResponse {
  readonly status_code: number;
  readonly response: ReadonlyArray<{
    readonly domain: string;
    readonly page_rank_integer: number;
    readonly page_rank_decimal: number;
    readonly rank: string;
    readonly status: string;
  }>;
  readonly error?: string;
}

export interface DomainRankResult {
  readonly domain: string;
  readonly pageRank: number;
  readonly rank: string;
  readonly source: "openpagerank";
}

// ─── Moz API ─────────────────────────────────────────────────────────────────

export interface MozMetricsResponse {
  readonly results: ReadonlyArray<{
    readonly domain_authority: number;
    readonly spam_score: number;
    readonly links_in?: number;
  }>;
}

export interface MozDomainMetrics {
  readonly domain: string;
  readonly domainAuthority: number;
  readonly spamScore: number;
  readonly linksIn?: number;
  readonly source: "moz";
}

// ─── Common Crawl ─────────────────────────────────────────────────────────────

export interface CommonCrawlRecord {
  readonly url: string;
  readonly timestamp: string;
  readonly status: string;
  readonly mime: string;
}

export interface BacklinkEntry {
  readonly url: string;
  readonly timestamp: string;
  readonly status: string;
  readonly source: "commoncrawl" | "dataforseo";
}

// ─── Referring Domains ────────────────────────────────────────────────────────

export interface ReferringDomain {
  readonly domain: string;
  readonly exampleUrl: string;
  readonly lastSeen: string;
  readonly source: "commoncrawl" | "dataforseo";
  readonly backlinkCount?: number;
  readonly dofollowCount?: number;
}

// ─── Top-level Tool Output Types ─────────────────────────────────────────────

export interface BacklinkProfile {
  readonly domain: string;
  readonly pageRank: number;
  readonly rank: string;
  /** Always "not fetched — use get_domain_authority tool" for this endpoint. */
  readonly domainAuthority: string;
  readonly totalBacklinks: number;
  readonly referringDomainsCount: number;
  readonly topBacklinks: readonly BacklinkEntry[];
}

export interface DomainComparison {
  readonly domainA: {
    readonly domain: string;
    readonly pageRank: number;
    readonly domainAuthority: number;
    readonly spamScore: number;
    readonly linksIn?: number;
  };
  readonly domainB: {
    readonly domain: string;
    readonly pageRank: number;
    readonly domainAuthority: number;
    readonly spamScore: number;
    readonly linksIn?: number;
  };
  readonly winner: string;
  readonly summary: string;
}

// ─── Referring Domains Tool Output ───────────────────────────────────────────

export interface ReferringDomainsOutput {
  readonly domain: string;
  readonly totalFound: number;
  readonly referringDomains: readonly ReferringDomain[];
}

// ─── Domain Authority Tool Output ─────────────────────────────────────────────

export interface DomainAuthorityOutput {
  readonly domain: string;
  readonly pageRank: number;
  readonly rank: string;
  readonly domainAuthority: number;
  readonly spamScore: number;
  readonly linksIn?: number;
}

// ─── Compare Domains Tool Output ─────────────────────────────────────────────

export interface CompareDomainsOutput {
  readonly comparison: DomainComparison;
}

// ─── DataForSEO API ───────────────────────────────────────────────────────────

/** DataForSEO Backlinks API request body */
export interface DataForSeoBacklinksRequest {
  readonly target: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly backlinks_status_type?: "all" | "live" | "lost";
}

/** DataForSEO API task item in response */
export interface DataForSeoTask {
  readonly id: string;
  readonly status_code: number;
  readonly status_message: string;
  readonly time: string;
  readonly cost: number;
  readonly result_count: number;
  readonly path: ReadonlyArray<string>;
  readonly data: DataForSeoBacklinksRequest;
  readonly result: ReadonlyArray<DataForSeoBacklinksResult> | null;
}

/** DataForSEO Backlinks API result */
export interface DataForSeoBacklinksResult {
  readonly target: string;
  readonly mode: string;
  readonly total_count: number;
  readonly items_count: number;
  readonly items: ReadonlyArray<DataForSeoBacklinkItem>;
}

/** Individual backlink item from DataForSEO */
export interface DataForSeoBacklinkItem {
  readonly type: string;
  readonly domain_from: string;
  readonly url_from: string;
  readonly domain_to: string;
  readonly url_to: string;
  readonly tld_from: string;
  readonly is_new: boolean;
  readonly is_lost: boolean;
  readonly backlink_spam_score: number;
  readonly rank: number;
  readonly page_from_rank: number;
  readonly page_from_status_code: number;
  readonly first_seen: string;
  readonly prev_seen: string;
  readonly last_seen: string;
  readonly link_type: string;
  readonly attribute: string;
  readonly anchor: string;
  readonly text_pre: string;
  readonly text_post: string;
  readonly dofollow: boolean;
}

/** DataForSEO Backlinks API response */
export interface DataForSeoBacklinksResponse {
  readonly version: string;
  readonly status_code: number;
  readonly status_message: string;
  readonly time: string;
  readonly cost: number;
  readonly tasks_count: number;
  readonly tasks_error: number;
  readonly tasks: ReadonlyArray<DataForSeoTask>;
}

/** DataForSEO referring domain item */
export interface DataForSeoReferringDomain {
  readonly domain: string;
  readonly backlinks: number;
  readonly dofollow_links: number;
  readonly first_seen: string;
  readonly last_seen: string;
}

/** DataForSEO domain metrics result */
export interface DataForSeoDomainMetrics {
  readonly domain: string;
  readonly totalBacklinks: number;
  readonly referringDomains: number;
  readonly referringIps: number;
  readonly referringSubnets: number;
  readonly dofollowLinks: number;
  readonly nofollowLinks: number;
  readonly source: "dataforseo";
}

/** DataForSEO backlink entry (normalized) */
export interface DataForSeoBacklinkEntry {
  readonly url: string;
  readonly domain: string;
  readonly targetUrl: string;
  readonly anchor: string;
  readonly dofollow: boolean;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly spamScore: number;
  readonly source: "dataforseo";
}
