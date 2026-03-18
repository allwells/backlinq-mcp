# Backlinq MCP — Architecture & Technical Reference

This document explains how the server works at every level, from a raw HTTP request arriving at the process to a structured JSON response leaving it. It also covers conclusions drawn from the current implementation and realistic improvement areas.

---

## Table of Contents

1. [Overview](#overview)
2. [Startup sequence](#startup-sequence)
3. [HTTP transport layer](#http-transport-layer)
4. [Request lifecycle](#request-lifecycle)
5. [Input validation](#input-validation)
6. [Caching strategy](#caching-strategy)
7. [Rate limit budget tracking](#rate-limit-budget-tracking)
8. [Background jobs](#background-jobs)
9. [Adapters](#adapters)
10. [Tools](#tools)
11. [Utility layer](#utility-layer)
12. [Error handling](#error-handling)
13. [Conclusions](#conclusions)

---

## Overview

Backlinq is a stateless MCP (Model Context Protocol) server. It exposes four tools over HTTP using the `StreamableHTTP` transport from `@modelcontextprotocol/sdk`. Each tool call is handled in its own isolated request — there is no session state between calls — but two background jobs run in the same process to keep the cache warm and pre-refresh domains before their data expires.

```
MCP Client (Claude, cursor, etc.)
        │
        │ POST /mcp  (JSON-RPC 2.0 over StreamableHTTP)
        ▼
  Express HTTP server
        │
        ▼
  StreamableHTTPServerTransport  ←→  McpServer
        │
        ▼
  Tool handler (one of 4 tools)
        │
        ├── SQLite cache check  (bun:sqlite)
        │        └── rate limit guard (serve stale at 80% budget)
        │
        ├── Moz Links API v2    (primary)
        │        └── recordApiCall() → moz_api_calls table
        │
        └── Common Crawl CDX    (fallback, tools 2 & 3 only)

Background (same process):
  ├── warm-cache job  — one-shot on boot, seeds ~1 000 domains
  └── preload job     — 24 h interval, refreshes top-missed expiring domains
```

**Data sources:**

| Source       | Endpoints used                                              | Role     |
| ------------ | ----------------------------------------------------------- | -------- |
| Moz API v2   | `url_metrics`, `/v2/links`, `/v2/linking_root_domains`      | Primary  |
| Common Crawl | `https://index.commoncrawl.org/CC-MAIN-{year}-{week}-index` | Fallback |

---

## Startup sequence

`src/index.ts` is the entry point. On boot:

1. **`dotenv/config`** is imported — loads `.env` into `process.env`.
2. **`validateEnv()`** checks that `MOZ_ACCESS_ID` and `MOZ_SECRET_KEY` are present. Missing variables abort the process immediately with a descriptive error — no silent failures.
3. **`initDatabase()`** opens (or creates) the SQLite file at `DB_PATH` (default: `./backlinq.db`), sets WAL journal mode, and runs `CREATE TABLE IF NOT EXISTS` for all six cache tables. On failure the error is caught, logged to stderr, and the server continues without caching.
4. **`startServer()`** starts the Express HTTP server on `PORT` (default: `8000`). The server is ready to accept requests at this point.
5. **`startPreloadJob()`** registers the 24-hour background refresh interval with a 1-hour initial delay.
6. **`runCacheWarmer()`** is fired in the background (not awaited). It checks `isWarmCacheComplete()` — if the seed list was already warmed in a previous run it returns immediately. On a first-ever boot it fetches DA for ~1 000 well-known domains sequentially and marks completion in the DB. Because it runs after the server is up, it never blocks incoming requests.

---

## HTTP transport layer

`src/server.ts` sets up two routes:

**`POST /mcp`** — the MCP endpoint. Because the server is stateless, a new `McpServer` instance and a new `StreamableHTTPServerTransport` are created per request. No shared mutable state means concurrent requests cannot interfere with each other. The transport handles JSON-RPC framing, and `McpServer` dispatches tool calls to the registered handlers.

**`GET /health`** — returns `{ status: "OK", service: "Backlinq MCP", version: "1.2.0" }`. Used by the host process manager or uptime monitoring to confirm the process is alive.

---

## Request lifecycle

A complete tool call goes through these steps:

```
1. POST /mcp  arrives with a JSON-RPC body:
   { "jsonrpc": "2.0", "id": 1, "method": "tools/call",
     "params": { "name": "get_domain_authority", "arguments": { "domain": "github.com" } } }

2. StreamableHTTPServerTransport deserialises the request and routes it to McpServer.

3. McpServer matches the tool name and calls the registered handler.

4. Handler: assertValidDomain(args.domain)
            → throws if invalid — caught and returned as isError: true JSON

5. Handler: domain = cleanDomain(args.domain)
            → strips protocol, www, trailing slashes, lowercases

6. Handler: logQuery(domain, toolName, cacheHit)   [SQLite, fire-and-forget]

7. Handler: fresh cache lookup in SQLite
            → HIT  → return immediately, no API call made
            → MISS → continue

8. Handler: isApproachingLimit() check
            → if true AND stale cache exists → return stale data with note
            → if true AND no stale data     → continue to API call anyway

9. Adapter call(s) through the async semaphore (withMozLimit)
            → fetch Moz API with Basic auth + 25s timeout
            → recordApiCall() writes to moz_api_calls table
            → on success: write result to SQLite cache
            → on failure: fall back to Common Crawl (tools 2 & 3) or throw (tools 1 & 4)

10. Enrichment computed from rich cache fields (anchor text, DA, link type)
            → backlink_intelligence, referring_domain_intelligence, verdict

11. Formatter combines adapter result into the output schema shape.

12. Handler returns { structuredContent: {...}, content: [{ type: "text", text: JSON.stringify(output) }] }

13. McpServer serialises the response and StreamableHTTPServerTransport writes it back
    as SSE (text/event-stream) or JSON depending on the client's Accept header.
```

---

## Input validation

`src/utils/validator.ts` performs all domain validation before any adapter is touched.

**`assertValidDomain(raw)`** rejects:

- Strings shorter than 4 characters
- Reserved hostnames: `localhost`, `local`, `lan`, `internal`, `intranet`, `home`, `broadcasthost`
- Any IPv4 address (all ranges)
- Private/loopback IPv4 ranges explicitly (`127.x`, `10.x`, `192.168.x`, `172.16–31.x`)
- IPv6 addresses
- Single-label names (no dot, i.e. no TLD)
- Anything failing the standard domain regex after cleaning

**`cleanDomain(raw)`** normalises the accepted input:

- Lowercases the entire string
- Strips `http://` or `https://` prefix
- Strips leading `www.`
- Strips path, query string, and fragment (`/`, `?`, `#` and everything after)

Validation runs on the raw input _before_ cleaning so that values like `"localhost/path"` are still caught.

**`extractRootDomain(cleaned)`** uses a simplified heuristic — splits on `.` and takes the last two parts, with a special case for common two-part TLDs (`.co.uk`, `.com.au`, `.co.nz`, `.co.za`). This is used when a Common Crawl lookup for a subdomain fails, to retry against the root.

---

## Caching strategy

There are two independent caching layers.

### Layer 1 — SQLite (Moz API responses)

`src/database.ts` manages six tables:

| Table                    | Key    | Cached data                                                                                                          | TTL       |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------- | --------- |
| `domain_authority_cache` | domain | `domainAuthority`, `spamScore`, `mozRank`, `linksIn`, `rootDomainsCount`                                             | 24 hours  |
| `backlink_cache`         | domain | one row per backlink — `url`, `timestamp`, `status`, `source`, `anchor_text`, `source_domain_authority`, `link_type` | 7 days    |
| `referring_domain_cache` | domain | one row per domain — `domain`, `exampleUrl`, `lastSeen`, `backlinkCount`, `dofollowCount`, `domainAuthority`         | 7 days    |
| `query_log`              | —      | `domain`, `tool_name`, `cache_hit`, `queried_at`                                                                     | permanent |
| `warm_cache_status`      | —      | `completed_at`, `domains_warmed` — single-row completion flag                                                        | permanent |
| `moz_api_calls`          | —      | `endpoint`, `domain`, `called_at`, `response_status`, `response_time_ms`                                             | permanent |

Expiry is enforced at read time via a `WHERE expires_at > ?` clause — no background sweep needed. Writes use transactions for multi-row inserts (backlinks, referring domains) to keep them atomic.

If the database cannot be opened at startup, all cache functions return `null`/`void` silently — the server degrades to no-cache mode and calls Moz on every request.

**Rich vs basic cache fallback.** The backlink and referring-domain tables now store extra fields (`anchor_text`, `source_domain_authority`, `link_type` / `domainAuthority`). Tool handlers call `getCachedBacklinksRich` / `getCachedReferringDomainsRich` first; if those return `null` (pre-enrichment cache entries with null extra fields), they fall back to the basic getter so old entries still serve data — just without the intelligence overlay.

**Stale cache.** All tools now have a secondary getter (`getStaleCachedDomainAuthority`, `getStaleCachedBacklinks`, `getStaleCachedReferringDomains`) that returns expired rows. These are only served when `isApproachingLimit()` returns true or when Moz is unreachable.

### Layer 2 — In-memory (Common Crawl responses)

`src/utils/cache.ts` is a `Map`-backed TTL cache used only for Common Crawl results. The cache key is `crawl:{domain}:{limit}`. TTL is 24 hours. This prevents re-fetching the same NDJSON crawl records within a session. Common Crawl results are not persisted to SQLite — they are cheap to re-fetch and their format does not map neatly to the relational schema.

---

## Rate limit budget tracking

`src/rateLimit.ts` provides budget-aware guards on top of the concurrency semaphore in `limiter.ts`.

```
MOZ_HOURLY_LIMIT = process.env.MOZ_HOURLY_LIMIT || 200
MOZ_DAILY_LIMIT  = process.env.MOZ_DAILY_LIMIT  || 2000
```

**How calls are tracked.** Every Moz adapter function (`getMozMetrics`, `getMozLinks`, `getMozLinkingRootDomains`) calls `recordApiCall(endpoint, domain, status, responseTimeMs)` after each request. This writes one row to the `moz_api_calls` table with a Unix timestamp. `getCallsInLastHour()` and `getCallsInLastDay()` query this table with a time-window `COUNT`.

**`isApproachingLimit()`** returns `true` when `getCallsInLastHour() >= 0.8 * MOZ_HOURLY_LIMIT`. Each tool handler checks this _after_ a fresh cache miss and _before_ making a Moz API call. If the limit is approaching and stale data exists, the stale response is returned with a `note` field explaining it. If no stale data exists, the live call proceeds regardless — a zero-result empty response is worse than a slightly over-budget call.

The concurrency semaphore (`withMozLimit`, capped at `MOZ_CONCURRENCY` in-flight calls) remains in place and operates independently of the budget tracker. The two mechanisms complement each other: the semaphore prevents bursts, the budget tracker prevents sustained overuse.

---

## Background jobs

### Cache warmer (`src/jobs/warm-cache.ts`)

A one-shot job that runs once per deployment (tracked by the `warm_cache_status` table). It iterates `SEED_DOMAINS` (`src/data/seed-domains.ts` — ~1 000 well-known domains across 18 categories) and calls `getMozMetrics` for each, writing results to `domain_authority_cache`. A 1-second delay between calls avoids triggering Moz's per-second rate limit. Progress is logged every 100 domains. The job is wrapped in `try/catch` — a failure midway does not prevent the server from starting, but completion is only marked when the full list has been processed, so an interrupted run will resume on the next cold start.

### Preload job (`src/jobs/preload.ts`)

A recurring job that runs every 24 hours, with the first run deferred 1 hour after startup (to avoid contending with the cache warmer). Each cycle:

1. Calls `getTopMissedDomains(500)` — the 500 domains with the most cache misses in `query_log`.
2. Filters to domains whose `domain_authority_cache` entry expires within 6 hours (`getDomainsNeedingRefresh`).
3. Fetches DA from Moz for each, sequentially with 1-second delays.
4. Logs a summary: domains checked, domains refreshed, Moz calls made.

This ensures frequently-queried domains almost never experience a cache miss on live traffic — their data is refreshed proactively before expiry.

---

## Adapters

### Moz (`src/adapters/moz.ts`)

All calls use Basic auth: `base64(MOZ_ACCESS_ID:MOZ_SECRET_KEY)`. A 25-second `AbortController` timeout is applied to every fetch. Each function records the call via `recordApiCall()` after every attempt (including failures, where `response_status` is recorded as `0`).

**`getMozMetrics(domain | domains[])`** → `url_metrics`

Accepts a single string or an array of up to 50 domains. Used in batch mode by `compare_domains` to fetch both domains in one API call. Maps the raw Moz response fields:

- `page_authority` (0–100) → `mozRank` (divided by 10 to produce a 0–10 scale)
- `domain_authority` → `domainAuthority` (0–100, unchanged)
- `spam_score` → `spamScore`
- `pages_to_root_domain` → `linksIn` (total inbound pages)
- `root_domains_to_root_domain` → `rootDomainsCount`

**`getMozLinks(domain, limit)`** → `/v2/links`

Returns individual backlink records including `anchor_text`, `source.domain_authority`, and `nofollow`. These extra fields are stored in the rich backlink cache for enrichment computation. The `source.page` field in Moz's response has no protocol prefix; the adapter prepends `https://` if absent.

**`getMozLinkingRootDomains(domain, limit)`** → `/v2/linking_root_domains`

Returns unique root domains linking to the target. Count fields are nested under `to_target`: `to_target.pages` (total linking pages) and `to_target.nofollow_pages`. `dofollowCount` is derived as `pages - nofollow_pages`. `domain_authority` is stored per row in the rich referring-domain cache.

### Common Crawl (`src/adapters/commonCrawl.ts`)

Queries the Common Crawl CDX index using the pattern `*.domain/*`. The response is NDJSON. Two filtering passes clean the results:

- **`isSelfEntry`** — removes records where the crawled URL belongs to the target domain itself
- **`isSelfRedirect`** — removes HTTP 3xx records where the redirect source and destination are the same root domain

If the filtered result is empty, the adapter throws `"No external backlinks found"`.

The index URL (`CC-MAIN-2026-08-index`) must be updated quarterly as new crawls are published.

---

## Tools

All four tools follow the same structure: validate → cache check → rate limit guard → adapter call → cache write → enrichment → format output → return.

### `get_domain_authority`

Calls `getMozMetrics` (single domain). Returns `domainAuthority`, `spamScore`, `mozRank`, `rank` tier string, and optionally `linksIn`.

Cache: reads/writes `domain_authority_cache` (24h TTL). On approaching rate limit or Moz failure, falls back to stale cache data with a `note` field.

Rank tiers: `mozRank >= 8` → "Top Tier", `>= 6` → "High", `>= 4` → "Mid", `>= 2` → "Low", else "Minimal".

### `get_backlink_profile`

Calls `getMozMetrics` and `getMozLinks` in parallel via `Promise.allSettled`. If `getMozMetrics` fails, the tool throws. If `getMozLinks` fails or returns empty, it falls back to Common Crawl.

On a Moz success, backlinks are stored as `RichBacklink[]` (with anchor text, source DA, nofollow flag) and a **`backlink_intelligence`** object is computed:

- `dofollow_ratio` — percentage of dofollow backlinks (0–100)
- `spam_risk` — `"low"` / `"medium"` / `"high"` derived from average source DA (>40 low, ≥20 medium, else high)
- `top_anchor_texts` — top 5 most frequent anchor strings
- `authority_distribution` — backlink counts split into DA tiers `0–30`, `31–60`, `61–100`

Cache: reads both `domain_authority_cache` and `backlink_cache`. A cache hit requires both. Common Crawl results are not written to SQLite.

### `get_referring_domains`

Calls `getMozLinkingRootDomains`. Falls back to Common Crawl if Moz returns empty or fails.

On a Moz success, domains are stored as `RichReferringDomain[]` (with DA per domain) and a **`referring_domain_intelligence`** object is computed:

- `average_referring_da` — mean Domain Authority across all referring domains
- `high_authority_count` — number of referring domains with DA > 60
- `dofollow_domain_ratio` — percentage of referring domains with at least one dofollow link

Common Crawl fallback aggregates raw backlink records into unique referring root domains using `normaliseToRootDomain` — subdomains are collapsed to their registrable domain.

Cache: reads/writes `referring_domain_cache` (7d TTL).

### `compare_domains`

Validates and cleans both domains, then checks `domain_authority_cache` independently for each. If both are cached, no Moz call is made. If one is cached, only the missing domain is fetched. If both are missing, a single batched `getMozMetrics([domainA, domainB])` call fetches both in one API request.

A **`verdict`** object is computed:

- `stronger_authority` — domain with higher DA
- `cleaner_profile` — domain with lower spam score
- `summary` — plain-language sentence describing the comparison

The rate limit guard checks stale cache for _both_ domains — it only serves stale data if both are available; a half-stale comparison would be misleading.

---

## Utility layer

| File           | Role                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validator.ts` | Domain validation and normalisation. Pure functions, no side effects.                                                                                                      |
| `formatter.ts` | Combines adapter outputs into tool output shapes. Pure functions.                                                                                                          |
| `logger.ts`    | Structured stderr logger. All output goes to `stderr` — MCP stdio transport uses `stdout` for protocol messages and any accidental `console.log` would corrupt the stream. |
| `cache.ts`     | In-memory TTL cache backed by a `Map`. Used only for Common Crawl results.                                                                                                 |
| `limiter.ts`   | Async semaphore. Caps concurrent Moz API calls at `MOZ_CONCURRENCY` (default 10).                                                                                          |
| `rateLimit.ts` | Budget tracker. Reads `moz_api_calls` to enforce hourly/daily limits; exposes `isApproachingLimit()` used by all four tools.                                               |

---

## Error handling

The design principle is: **a tool call must never crash the server or return an unstructured response**. Every tool handler wraps its entire body in a `try/catch`. On any error:

```typescript
return {
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: true, code: "...", message: "..." }),
    },
  ],
  isError: true,
};
```

This guarantees the MCP client always receives a parseable JSON response regardless of what went wrong internally.

Adapter-level errors propagate up to the tool handler's catch block. The only exception is the SQLite layer: all database functions are wrapped in their own `try/catch` and return `null`/`void` on failure. Database errors are logged to stderr but never bubble up to the tool handler.

Background jobs (`warm-cache`, `preload`) have their own top-level `try/catch`. A job failure is logged to stderr and does not affect the HTTP server.

---

## Conclusions

### What works well

- **Single data source.** Having Moz as the sole primary source removes the complexity of blending results from multiple APIs. The Common Crawl fallback is narrow in scope — it activates only when Moz returns empty, not as a parallel enrichment layer.

- **Two-layer caching.** SQLite for Moz (persisted across restarts, multi-day TTLs) and in-memory for Common Crawl (cheap to re-fetch, session-scoped) is a sensible split. The TTLs are reasonable: domain authority changes slowly (24h is fine), backlink profiles change even slower (7d is fine).

- **Proactive cache management.** The combination of seed-based warming on first deployment and miss-driven preloading on a 24h cycle means frequently-queried domains almost never hit the API on live traffic. Cold-start latency is absorbed offline.

- **Budget-aware degradation.** Serving stale data with a `note` field at 80% of hourly budget is a better trade-off than either hard-failing or blindly exceeding Moz's quota. Clients get data; the operator keeps their account in good standing.

- **Rich enrichment without extra API calls.** `backlink_intelligence`, `referring_domain_intelligence`, and the `compare_domains` verdict are computed entirely from fields already returned by Moz's existing endpoints. No new API calls, no new adapters.

- **Stateless per-request server instances.** Creating a new `McpServer` per request eliminates any possibility of state leaking between concurrent clients. For an I/O-bound MCP server, this is the right trade-off.
