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

// ─── Open PageRank (legacy — adapter kept but no longer called) ───────────────

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
  readonly source: "openpagerank" | "moz";
}

// ─── Moz API ─────────────────────────────────────────────────────────────────

export interface MozMetricsResponse {
  readonly results: ReadonlyArray<{
    readonly domain_authority: number;
    readonly spam_score: number;
    /** Total pages linking to this root domain (used as linksIn) */
    readonly pages_to_root_domain?: number;
    /** Page Authority 0–100 — divided by 10 to produce a 0–10 mozRank proxy */
    readonly page_authority?: number;
    /** Number of unique root domains linking to this root domain */
    readonly root_domains_to_root_domain?: number;
  }>;
}

export interface MozDomainMetrics {
  readonly domain: string;
  readonly domainAuthority: number;
  readonly spamScore: number;
  /** Total inbound pages (pages_to_root_domain) */
  readonly linksIn?: number;
  /** Page Authority / 10 — 0–10 proxy for PageRank */
  readonly mozRank: number;
  /** Total referring root domains */
  readonly rootDomainsCount?: number;
  readonly source: "moz";
}

// ─── Moz Links API (/v2/links) ────────────────────────────────────────────────

/** Source/target page object nested inside a /v2/links result item */
export interface MozLinkPage {
  /** URL path (no protocol), e.g. "example.com/page" */
  readonly page: string;
  readonly root_domain?: string;
  readonly domain_authority?: number;
  readonly last_crawled?: string;
}

export interface MozLink {
  readonly source: MozLinkPage;
  readonly target?: MozLinkPage;
  readonly anchor_text?: string;
  readonly nofollow?: boolean;
  readonly date_last_seen?: string;
  readonly date_first_seen?: string;
}

export interface MozLinksResponse {
  readonly results: ReadonlyArray<MozLink>;
  readonly next_token?: string;
}

// ─── Moz Linking Root Domains API (/v2/linking_root_domains) ─────────────────

export interface MozLinkingRootDomain {
  /** Root domain linking to the target */
  readonly root_domain: string;
  readonly domain_authority?: number;
  readonly spam_score?: number;
  /** Nested counts for links pointing at the target */
  readonly to_target?: {
    readonly pages?: number;
    readonly nofollow_pages?: number;
    readonly redirect_pages?: number;
    readonly deleted_pages?: number;
  };
}

export interface MozLinkingRootDomainsResponse {
  readonly results: ReadonlyArray<MozLinkingRootDomain>;
  readonly next_token?: string;
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
  readonly source: "commoncrawl" | "moz";
}

// ─── Referring Domains ────────────────────────────────────────────────────────

export interface ReferringDomain {
  readonly domain: string;
  readonly exampleUrl: string;
  readonly lastSeen: string;
  readonly source: "commoncrawl" | "moz";
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

