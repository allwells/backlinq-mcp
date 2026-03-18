// SQLite caching layer — persists Moz API responses to avoid redundant calls
// All DB operations are synchronous (better-sqlite3) and wrapped in try-catch.
// A DB failure must never crash the server — all functions return null/void on error.

import { Database } from "bun:sqlite";
import type { MozDomainMetrics, BacklinkEntry, ReferringDomain } from "./types/index.js";
import { logger } from "./utils/logger.js";

const TTL_24H = 24 * 60 * 60 * 1000; // domain authority — 24 hours
const TTL_7D = 7 * 24 * 60 * 60 * 1000; // backlinks / referring domains — 7 days

let db: Database | null = null;

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS domain_authority_cache (
    domain              TEXT PRIMARY KEY,
    domain_authority    INTEGER,
    page_authority      INTEGER,
    spam_score          INTEGER,
    moz_rank            REAL,
    links_in            INTEGER,
    root_domains_count  INTEGER,
    fetched_at          INTEGER NOT NULL,
    expires_at          INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS backlink_cache (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    domain                  TEXT NOT NULL,
    source_url              TEXT,
    timestamp               TEXT,
    status                  TEXT,
    source                  TEXT,
    anchor_text             TEXT,
    source_domain_authority INTEGER,
    link_type               TEXT,
    fetched_at              INTEGER NOT NULL,
    expires_at              INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_backlink_domain ON backlink_cache(domain);

  CREATE TABLE IF NOT EXISTS referring_domain_cache (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    domain           TEXT NOT NULL,
    referring_domain TEXT,
    last_seen        TEXT,
    source           TEXT,
    domain_authority INTEGER,
    backlink_count   INTEGER,
    dofollow_count   INTEGER,
    example_url      TEXT,
    fetched_at       INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_referring_domain ON referring_domain_cache(domain);

  CREATE TABLE IF NOT EXISTS query_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    domain      TEXT,
    tool_name   TEXT,
    cache_hit   INTEGER,
    queried_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS warm_cache_status (
    id              INTEGER PRIMARY KEY,
    completed_at    INTEGER,
    domains_warmed  INTEGER
  );

  CREATE TABLE IF NOT EXISTS moz_api_calls (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint         TEXT,
    domain           TEXT,
    called_at        INTEGER,
    response_status  INTEGER,
    response_time_ms INTEGER
  );
`;

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initDatabase(): void {
  const dbPath = process.env.DB_PATH ?? "./backlinq.db";
  try {
    db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    logger.info(`Database initialised at ${dbPath}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[Backlinq] Database init failed (${msg}) — running without cache\n`);
    db = null;
  }
}

// ─── Domain Authority Cache ───────────────────────────────────────────────────

export function getCachedDomainAuthority(domain: string): MozDomainMetrics | null {
  if (!db) return null;
  try {
    const row = db
      .prepare("SELECT * FROM domain_authority_cache WHERE domain = ? AND expires_at > ?")
      .get(domain, Date.now()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      domain: row.domain as string,
      domainAuthority: row.domain_authority as number,
      spamScore: row.spam_score as number,
      mozRank: row.moz_rank as number,
      linksIn: row.links_in != null ? (row.links_in as number) : undefined,
      rootDomainsCount:
        row.root_domains_count != null ? (row.root_domains_count as number) : undefined,
      source: "moz",
    };
  } catch {
    return null;
  }
}

/** Returns expired data if present — used as stale fallback when Moz is unavailable. */
export function getStaleCachedDomainAuthority(domain: string): MozDomainMetrics | null {
  if (!db) return null;
  try {
    const row = db
      .prepare("SELECT * FROM domain_authority_cache WHERE domain = ?")
      .get(domain) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      domain: row.domain as string,
      domainAuthority: row.domain_authority as number,
      spamScore: row.spam_score as number,
      mozRank: row.moz_rank as number,
      linksIn: row.links_in != null ? (row.links_in as number) : undefined,
      rootDomainsCount:
        row.root_domains_count != null ? (row.root_domains_count as number) : undefined,
      source: "moz",
    };
  } catch {
    return null;
  }
}

export function setCachedDomainAuthority(domain: string, data: MozDomainMetrics): void {
  if (!db) return;
  try {
    const now = Date.now();
    db.prepare(`
      INSERT OR REPLACE INTO domain_authority_cache
        (domain, domain_authority, page_authority, spam_score, moz_rank, links_in, root_domains_count, fetched_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      domain,
      data.domainAuthority,
      Math.round(data.mozRank * 10),
      data.spamScore,
      data.mozRank,
      data.linksIn ?? null,
      data.rootDomainsCount ?? null,
      now,
      now + TTL_24H,
    );
  } catch {
    // DB errors must never crash the server
  }
}

// ─── Backlink Cache ───────────────────────────────────────────────────────────

export function getCachedBacklinks(domain: string): readonly BacklinkEntry[] | null {
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        "SELECT * FROM backlink_cache WHERE domain = ? AND expires_at > ? ORDER BY id",
      )
      .all(domain, Date.now()) as Array<Record<string, unknown>>;
    if (!rows.length) return null;
    return rows.map((row) => ({
      url: row.source_url as string,
      timestamp: row.timestamp as string,
      status: row.status as string,
      source: row.source as "commoncrawl" | "moz",
    }));
  } catch {
    return null;
  }
}

export function setCachedBacklinks(domain: string, backlinks: readonly BacklinkEntry[]): void {
  if (!db) return;
  try {
    const now = Date.now();
    const expires = now + TTL_7D;
    const transaction = db.transaction(() => {
      db!.prepare("DELETE FROM backlink_cache WHERE domain = ?").run(domain);
      const insert = db!.prepare(
        "INSERT INTO backlink_cache (domain, source_url, timestamp, status, source, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const bl of backlinks) {
        insert.run(domain, bl.url, bl.timestamp, bl.status, bl.source, now, expires);
      }
    });
    transaction();
  } catch {
    // DB errors must never crash the server
  }
}

// ─── Referring Domain Cache ───────────────────────────────────────────────────

export function getCachedReferringDomains(domain: string): readonly ReferringDomain[] | null {
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        "SELECT * FROM referring_domain_cache WHERE domain = ? AND expires_at > ? ORDER BY id",
      )
      .all(domain, Date.now()) as Array<Record<string, unknown>>;
    if (!rows.length) return null;
    return rows.map((row) => ({
      domain: row.referring_domain as string,
      exampleUrl: row.example_url as string,
      lastSeen: row.last_seen as string,
      source: row.source as "commoncrawl" | "moz",
      backlinkCount: row.backlink_count != null ? (row.backlink_count as number) : undefined,
      dofollowCount: row.dofollow_count != null ? (row.dofollow_count as number) : undefined,
    }));
  } catch {
    return null;
  }
}

export function setCachedReferringDomains(
  domain: string,
  referringDomains: readonly ReferringDomain[],
): void {
  if (!db) return;
  try {
    const now = Date.now();
    const expires = now + TTL_7D;
    const transaction = db.transaction(() => {
      db!.prepare("DELETE FROM referring_domain_cache WHERE domain = ?").run(domain);
      const insert = db!.prepare(`
        INSERT INTO referring_domain_cache
          (domain, referring_domain, last_seen, source, domain_authority, backlink_count, dofollow_count, example_url, fetched_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const rd of referringDomains) {
        insert.run(
          domain,
          rd.domain,
          rd.lastSeen,
          rd.source,
          null, // domain_authority not in ReferringDomain type
          rd.backlinkCount ?? null,
          rd.dofollowCount ?? null,
          rd.exampleUrl,
          now,
          expires,
        );
      }
    });
    transaction();
  } catch {
    // DB errors must never crash the server
  }
}

// ─── Query Log ────────────────────────────────────────────────────────────────

export function logQuery(domain: string, toolName: string, cacheHit: boolean): void {
  if (!db) return;
  try {
    db.prepare(
      "INSERT INTO query_log (domain, tool_name, cache_hit, queried_at) VALUES (?, ?, ?, ?)",
    ).run(domain, toolName, cacheHit ? 1 : 0, Date.now());
  } catch {
    // DB errors must never crash the server
  }
}

// ─── Rich Cache Types ─────────────────────────────────────────────────────────

export interface RichBacklink {
  url: string;
  timestamp: string;
  status: string;
  source: "commoncrawl" | "moz";
  anchorText: string | null;
  sourceDomainAuthority: number | null;
  nofollow: boolean;
}

export interface RichReferringDomain {
  domain: string;
  exampleUrl: string;
  lastSeen: string;
  source: "commoncrawl" | "moz";
  backlinkCount?: number;
  dofollowCount?: number;
  domainAuthority?: number;
}

// ─── Rich Backlink Cache ──────────────────────────────────────────────────────

export function setCachedBacklinksRich(domain: string, backlinks: readonly RichBacklink[]): void {
  if (!db) return;
  try {
    const now = Date.now();
    const expires = now + TTL_7D;
    const transaction = db.transaction(() => {
      db!.prepare("DELETE FROM backlink_cache WHERE domain = ?").run(domain);
      const insert = db!.prepare(
        "INSERT INTO backlink_cache (domain, source_url, timestamp, status, source, anchor_text, source_domain_authority, link_type, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const bl of backlinks) {
        insert.run(
          domain,
          bl.url,
          bl.timestamp,
          bl.status,
          bl.source,
          bl.anchorText,
          bl.sourceDomainAuthority,
          bl.nofollow ? "nofollow" : "dofollow",
          now,
          expires,
        );
      }
    });
    transaction();
  } catch {
    // DB errors must never crash the server
  }
}

export function getCachedBacklinksRich(domain: string): readonly RichBacklink[] | null {
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        "SELECT * FROM backlink_cache WHERE domain = ? AND expires_at > ? ORDER BY id",
      )
      .all(domain, Date.now()) as Array<Record<string, unknown>>;
    if (!rows.length) return null;
    return rows.map((row) => ({
      url: row.source_url as string,
      timestamp: row.timestamp as string,
      status: row.status as string,
      source: row.source as "commoncrawl" | "moz",
      anchorText: row.anchor_text != null ? (row.anchor_text as string) : null,
      sourceDomainAuthority:
        row.source_domain_authority != null ? (row.source_domain_authority as number) : null,
      nofollow: row.link_type === "nofollow",
    }));
  } catch {
    return null;
  }
}

export function getStaleCachedBacklinks(domain: string): readonly import("./types/index.js").BacklinkEntry[] | null {
  if (!db) return null;
  try {
    const rows = db
      .prepare("SELECT * FROM backlink_cache WHERE domain = ? ORDER BY id")
      .all(domain) as Array<Record<string, unknown>>;
    if (!rows.length) return null;
    return rows.map((row) => ({
      url: row.source_url as string,
      timestamp: row.timestamp as string,
      status: row.status as string,
      source: row.source as "commoncrawl" | "moz",
    }));
  } catch {
    return null;
  }
}

// ─── Rich Referring Domain Cache ──────────────────────────────────────────────

export function setCachedReferringDomainsRich(
  domain: string,
  referringDomains: readonly RichReferringDomain[],
): void {
  if (!db) return;
  try {
    const now = Date.now();
    const expires = now + TTL_7D;
    const transaction = db.transaction(() => {
      db!.prepare("DELETE FROM referring_domain_cache WHERE domain = ?").run(domain);
      const insert = db!.prepare(`
        INSERT INTO referring_domain_cache
          (domain, referring_domain, last_seen, source, domain_authority, backlink_count, dofollow_count, example_url, fetched_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const rd of referringDomains) {
        insert.run(
          domain,
          rd.domain,
          rd.lastSeen,
          rd.source,
          rd.domainAuthority ?? null,
          rd.backlinkCount ?? null,
          rd.dofollowCount ?? null,
          rd.exampleUrl,
          now,
          expires,
        );
      }
    });
    transaction();
  } catch {
    // DB errors must never crash the server
  }
}

export function getCachedReferringDomainsRich(domain: string): readonly RichReferringDomain[] | null {
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        "SELECT * FROM referring_domain_cache WHERE domain = ? AND expires_at > ? ORDER BY id",
      )
      .all(domain, Date.now()) as Array<Record<string, unknown>>;
    if (!rows.length) return null;
    return rows.map((row) => ({
      domain: row.referring_domain as string,
      exampleUrl: row.example_url as string,
      lastSeen: row.last_seen as string,
      source: row.source as "commoncrawl" | "moz",
      backlinkCount: row.backlink_count != null ? (row.backlink_count as number) : undefined,
      dofollowCount: row.dofollow_count != null ? (row.dofollow_count as number) : undefined,
      domainAuthority: row.domain_authority != null ? (row.domain_authority as number) : undefined,
    }));
  } catch {
    return null;
  }
}

export function getStaleCachedReferringDomains(domain: string): readonly import("./types/index.js").ReferringDomain[] | null {
  if (!db) return null;
  try {
    const rows = db
      .prepare("SELECT * FROM referring_domain_cache WHERE domain = ? ORDER BY id")
      .all(domain) as Array<Record<string, unknown>>;
    if (!rows.length) return null;
    return rows.map((row) => ({
      domain: row.referring_domain as string,
      exampleUrl: row.example_url as string,
      lastSeen: row.last_seen as string,
      source: row.source as "commoncrawl" | "moz",
      backlinkCount: row.backlink_count != null ? (row.backlink_count as number) : undefined,
      dofollowCount: row.dofollow_count != null ? (row.dofollow_count as number) : undefined,
    }));
  } catch {
    return null;
  }
}

// ─── Query Log Analytics ──────────────────────────────────────────────────────

export function getTopMissedDomains(limit: number): string[] {
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        "SELECT domain, COUNT(*) as cnt FROM query_log WHERE cache_hit = 0 GROUP BY domain ORDER BY cnt DESC LIMIT ?",
      )
      .all(limit) as Array<{ domain: string }>;
    return rows.map((r) => r.domain).filter(Boolean);
  } catch {
    return [];
  }
}

export function getDomainsNeedingRefresh(domains: string[], windowMs: number): string[] {
  if (!db) return [];
  try {
    const threshold = Date.now() + windowMs;
    const result: string[] = [];
    const stmt = db.prepare("SELECT expires_at FROM domain_authority_cache WHERE domain = ?");
    for (const domain of domains) {
      const row = stmt.get(domain) as { expires_at: number } | undefined;
      if (!row || row.expires_at <= threshold) {
        result.push(domain);
      }
    }
    return result;
  } catch {
    return [];
  }
}

// ─── Warm Cache Status ────────────────────────────────────────────────────────

export function isWarmCacheComplete(): boolean {
  if (!db) return false;
  try {
    const row = db
      .prepare("SELECT completed_at FROM warm_cache_status WHERE id = 1")
      .get() as { completed_at: number | null } | undefined;
    return !!(row && row.completed_at != null);
  } catch {
    return false;
  }
}

export function markWarmCacheComplete(domainsWarmed: number): void {
  if (!db) return;
  try {
    db.prepare(
      "INSERT OR REPLACE INTO warm_cache_status (id, completed_at, domains_warmed) VALUES (1, ?, ?)",
    ).run(Date.now(), domainsWarmed);
  } catch {
    // DB errors must never crash the server
  }
}

// ─── Moz API Call Tracking ────────────────────────────────────────────────────

export function recordMozApiCall(
  endpoint: string,
  domain: string,
  status: number,
  responseTimeMs: number,
): void {
  if (!db) return;
  try {
    db.prepare(
      "INSERT INTO moz_api_calls (endpoint, domain, called_at, response_status, response_time_ms) VALUES (?, ?, ?, ?, ?)",
    ).run(endpoint, domain, Date.now(), status, responseTimeMs);
  } catch {
    // DB errors must never crash the server
  }
}

export function getMozCallsInWindow(windowMs: number): number {
  if (!db) return 0;
  try {
    const row = db
      .prepare("SELECT COUNT(*) as cnt FROM moz_api_calls WHERE called_at > ?")
      .get(Date.now() - windowMs) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}
