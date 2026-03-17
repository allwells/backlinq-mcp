#!/usr/bin/env bun
// Cache statistics CLI — reads query_log and cache tables, prints a summary.
// Usage: bun run cache:stats

import "dotenv/config";
import { Database } from "bun:sqlite";

const dbPath = process.env.DB_PATH ?? "./backlinq.db";

let db: Database;
try {
  db = new Database(dbPath, { readonly: true });
} catch {
  console.error(`Cannot open database at ${dbPath}`);
  process.exit(1);
}

// ─── Query log stats ──────────────────────────────────────────────────────────

const total = (
  db.prepare("SELECT COUNT(*) as n FROM query_log").get() as { n: number }
).n;

if (total === 0) {
  console.log("No queries logged yet.");
  process.exit(0);
}

const hits = (
  db
    .prepare("SELECT COUNT(*) as n FROM query_log WHERE cache_hit = 1")
    .get() as { n: number }
).n;

const hitRate = total > 0 ? ((hits / total) * 100).toFixed(1) : "0.0";

console.log(`\nBacklinq Cache Stats — ${dbPath}\n`);
console.log(`Total queries : ${total}`);
console.log(`Cache hits    : ${hits}  (${hitRate}%)`);
console.log(`Cache misses  : ${total - hits}  (${(100 - Number(hitRate)).toFixed(1)}%)`);

// ─── Per-tool breakdown ───────────────────────────────────────────────────────

const byTool = db
  .prepare(`
    SELECT
      tool_name,
      COUNT(*) AS total,
      SUM(cache_hit) AS hits
    FROM query_log
    GROUP BY tool_name
    ORDER BY total DESC
  `)
  .all() as Array<{ tool_name: string; total: number; hits: number }>;

console.log("\nBy tool:");
console.log(
  `${"Tool".padEnd(30)} ${"Queries".padStart(8)} ${"Hits".padStart(8)} ${"Hit %".padStart(8)}`,
);
console.log("─".repeat(58));
for (const row of byTool) {
  const pct = row.total > 0 ? ((row.hits / row.total) * 100).toFixed(1) : "0.0";
  console.log(
    `${row.tool_name.padEnd(30)} ${String(row.total).padStart(8)} ${String(row.hits).padStart(8)} ${(pct + "%").padStart(8)}`,
  );
}

// ─── Top queried domains ──────────────────────────────────────────────────────

const topDomains = db
  .prepare(`
    SELECT domain, COUNT(*) AS total
    FROM query_log
    GROUP BY domain
    ORDER BY total DESC
    LIMIT 10
  `)
  .all() as Array<{ domain: string; total: number }>;

console.log("\nTop 10 domains:");
console.log(`${"Domain".padEnd(40)} ${"Queries".padStart(8)}`);
console.log("─".repeat(50));
for (const row of topDomains) {
  console.log(`${row.domain.padEnd(40)} ${String(row.total).padStart(8)}`);
}

// ─── Cache table sizes ────────────────────────────────────────────────────────

const daCount = (
  db.prepare("SELECT COUNT(*) as n FROM domain_authority_cache").get() as {
    n: number;
  }
).n;
const blCount = (
  db
    .prepare("SELECT COUNT(DISTINCT domain) as n FROM backlink_cache")
    .get() as { n: number }
).n;
const rdCount = (
  db
    .prepare(
      "SELECT COUNT(DISTINCT domain) as n FROM referring_domain_cache",
    )
    .get() as { n: number }
).n;

console.log("\nCached entries:");
console.log(`  domain_authority_cache : ${daCount} domains`);
console.log(`  backlink_cache         : ${blCount} domains`);
console.log(`  referring_domain_cache : ${rdCount} domains`);
console.log();

db.close();
