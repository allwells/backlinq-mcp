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
7. [Rate limiting](#rate-limiting)
8. [Adapters](#adapters)
9. [Tools](#tools)
10. [Utility layer](#utility-layer)
11. [Error handling](#error-handling)
12. [Conclusions](#conclusions)

---

## Overview

Backlinq is a stateless MCP (Model Context Protocol) server. It exposes four tools over HTTP using the `StreamableHTTP` transport from `@modelcontextprotocol/sdk`. Each tool call is handled in its own isolated request — there is no session state, no shared mutable state between calls, and no background workers.

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
        │
        ├── Moz Links API v2    (primary)
        │
        └── Common Crawl CDX    (fallback, tools 2 & 3 only)
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
3. **`initDatabase()`** is called. It opens (or creates) the SQLite file at `DB_PATH` (default: `./backlinq.db`), sets WAL journal mode for concurrent read performance, and runs `CREATE TABLE IF NOT EXISTS` for all four cache tables. If this fails for any reason — bad path, permissions, disk full — the error is caught, logged to stderr, and the server continues running without caching. The database is completely optional at runtime.
4. **`startServer()`** starts the Express HTTP server on `PORT` (default: `8000`).

---

## HTTP transport layer

`src/server.ts` sets up two routes:

**`POST /mcp`** — the MCP endpoint. Because the server is stateless, a new `McpServer` instance and a new `StreamableHTTPServerTransport` are created per request. This is intentional: no shared mutable state means concurrent requests cannot interfere with each other. The transport handles JSON-RPC framing, and `McpServer` dispatches tool calls to the registered handlers.

**`GET /health`** — returns `{ status: "OK", service: "Backlinq MCP", version: "1.1.0" }`. Used by the host process manager or uptime monitoring to confirm the process is alive.

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

7. Handler: cache lookup in SQLite
            → HIT  → return immediately, no API call made
            → MISS → continue

8. Adapter call(s) through the async semaphore (withMozLimit)
            → fetch Moz API with Basic auth + 25s timeout
            → on success: write result to SQLite cache
            → on failure: fall back to Common Crawl (tools 2 & 3) or throw (tools 1 & 4)

9. Formatter combines adapter result into the output schema shape.

10. Handler returns { structuredContent: {...}, content: [{ type: "text", text: JSON.stringify(output) }] }

11. McpServer serialises the response and StreamableHTTPServerTransport writes it back
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

`src/database.ts` manages four tables:

| Table                    | Key    | Cached data                                                                                          | TTL       |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------------------- | --------- |
| `domain_authority_cache` | domain | `domainAuthority`, `spamScore`, `mozRank`, `linksIn`, `rootDomainsCount`                             | 24 hours  |
| `backlink_cache`         | domain | one row per `BacklinkEntry` (`url`, `timestamp`, `status`, `source`)                                 | 7 days    |
| `referring_domain_cache` | domain | one row per `ReferringDomain` (`domain`, `exampleUrl`, `lastSeen`, `backlinkCount`, `dofollowCount`) | 7 days    |
| `query_log`              | —      | `domain`, `tool_name`, `cache_hit`, `queried_at`                                                     | permanent |

Expiry is enforced at read time via a `WHERE expires_at > ?` clause — no background sweep needed. Writes use transactions for multi-row inserts (backlinks, referring domains) to keep them atomic.

If the database cannot be opened at startup, all cache functions return `null`/`void` silently — the server degrades to no-cache mode and calls Moz on every request.

`get_domain_authority` has an additional stale fallback: if Moz is unreachable and the domain exists in the cache (even expired), the stale data is returned with a `note` field explaining it. The other tools do not implement this — they fail loudly if Moz is down.

### Layer 2 — In-memory (Common Crawl responses)

`src/utils/cache.ts` is a `Map`-backed TTL cache used only for Common Crawl results. The cache key is `crawl:{domain}:{limit}`. TTL is 24 hours, matching the frequency at which Common Crawl updates its index. This prevents re-fetching the same NDJSON crawl records within a session.

This layer is separate from SQLite because Common Crawl results are not persisted across restarts — they're cheap to re-fetch and their format does not map neatly to the relational schema. SQLite is reserved for Moz data, which is metered and costs API quota.

---

## Rate limiting

`src/utils/limiter.ts` implements a simple async semaphore.

```
MAX_CONCURRENT = process.env.MOZ_CONCURRENCY || 10
```

Every Moz fetch (all three endpoints) is wrapped in `withMozLimit()`. If the number of in-flight Moz requests reaches `MAX_CONCURRENT`, subsequent calls queue and wait for a slot to free. This prevents a burst of concurrent MCP clients from exhausting Moz's per-second quota.

The semaphore is process-global — it is shared across all concurrent HTTP requests. It is not distributed; in a multi-process deployment each process has its own counter.

---

## Adapters

### Moz (`src/adapters/moz.ts`)

All calls use Basic auth: `base64(MOZ_ACCESS_ID:MOZ_SECRET_KEY)`. Credentials are validated at module load time — the server will not start if either is missing. A 25-second `AbortController` timeout is applied to every fetch.

**`getMozMetrics(domain | domains[])`** → `url_metrics`

Accepts a single string or an array of up to 50 domains. Used in batch mode by `compare_domains` to fetch both domains in one API call. Maps the raw Moz response fields:

- `page_authority` (0–100) → `mozRank` (divided by 10 to produce a 0–10 scale)
- `domain_authority` → `domainAuthority` (0–100, unchanged)
- `spam_score` → `spamScore`
- `pages_to_root_domain` → `linksIn` (total inbound pages)
- `root_domains_to_root_domain` → `rootDomainsCount`

**`getMozLinks(domain, limit)`** → `/v2/links`

Returns individual backlink records. Request body: `{ target: "https://domain/", scope: "root_domain", limit }`. The `filter` and `type` params are intentionally omitted — Moz rejects requests with `filter: "all"` (HTTP 400). The `source.page` field in Moz's response has no protocol prefix; the adapter prepends `https://` if absent.

**`getMozLinkingRootDomains(domain, limit)`** → `/v2/linking_root_domains`

Returns unique root domains linking to the target. Count fields are nested under `to_target`: `to_target.pages` (total linking pages) and `to_target.nofollow_pages`. `dofollowCount` is derived as `pages - nofollow_pages`.

### Common Crawl (`src/adapters/commonCrawl.ts`)

Queries the Common Crawl CDX index using the pattern `*.domain/*` to find pages that were crawled under the given domain. The response is NDJSON — one JSON object per line.

Two filtering passes clean the results:

- **`isSelfEntry`** — removes records where the crawled URL belongs to the target domain itself (Common Crawl returns the target's own pages, not pages linking to it)
- **`isSelfRedirect`** — removes HTTP 3xx records where the redirect source and destination are the same root domain (protocol/www normalisation redirects)

If the filtered result is empty, the adapter throws `"No external backlinks found"` — this propagates to the tool as an empty/fallback response.

The index URL (`CC-MAIN-2026-08-index`) must be updated quarterly as new crawls are published.

---

## Tools

All four tools follow the same structure: validate → cache check → adapter call → cache write → format output → return.

### `get_domain_authority`

Calls `getMozMetrics` (single domain). Returns `domainAuthority`, `spamScore`, `mozRank`, `rank` tier string, and optionally `linksIn`.

Cache: reads/writes `domain_authority_cache` (24h TTL). On Moz failure, falls back to stale cache data with a `note` field.

Rank tiers: `mozRank >= 8` → "Top Tier", `>= 6` → "High", `>= 4` → "Mid", `>= 2` → "Low", else "Minimal".

### `get_backlink_profile`

Calls `getMozMetrics` and `getMozLinks` in parallel via `Promise.allSettled`. If `getMozMetrics` fails, the tool throws. If `getMozLinks` fails or returns empty, it falls back to Common Crawl.

Cache: reads both `domain_authority_cache` and `backlink_cache`. A cache hit requires both to be present. On a Moz primary success, writes both caches. Common Crawl results are not written to SQLite (covered by the in-memory layer).

`totalBacklinks` and `referringDomainsCount` are taken from `url_metrics` counts (`linksIn`, `rootDomainsCount`) for accuracy — these reflect Moz's full index, not just the sampled list returned by `/v2/links`.

### `get_referring_domains`

Calls `getMozLinkingRootDomains`. Falls back to Common Crawl if Moz returns empty or fails.

Common Crawl fallback aggregates raw backlink records into unique referring root domains using `normaliseToRootDomain` — subdomains (`blog.example.com`) are collapsed to their registrable domain (`example.com`).

Cache: reads/writes `referring_domain_cache` (7d TTL).

### `compare_domains`

Validates and cleans both domains, then checks `domain_authority_cache` independently for each. If both are cached, no Moz call is made. If one is cached, only the missing domain is fetched as a single call. If both are missing, a single batched `getMozMetrics([domainA, domainB])` call fetches both in one API request.

The winner is determined by a composite score: `mozRank + (domainAuthority / 10)`. This normalises both to the same 0–10 scale before summing.

---

## Utility layer

| File           | Role                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validator.ts` | Domain validation and normalisation. Pure functions, no side effects.                                                                                                      |
| `formatter.ts` | Combines adapter outputs into tool output shapes. Pure functions.                                                                                                          |
| `logger.ts`    | Structured stderr logger. All output goes to `stderr` — MCP stdio transport uses `stdout` for protocol messages and any accidental `console.log` would corrupt the stream. |
| `cache.ts`     | In-memory TTL cache backed by a `Map`. Used only for Common Crawl results.                                                                                                 |
| `limiter.ts`   | Async semaphore. Caps concurrent Moz API calls at `MOZ_CONCURRENCY` (default 10).                                                                                          |

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

Adapter-level errors are not swallowed — they propagate up to the tool handler's catch block. The only exception is the SQLite layer: all database functions are wrapped in their own `try/catch` and return `null`/`void` on failure. Database errors are logged to stderr but never bubble up to the tool handler.

---

## Conclusions

### What works well

- **Single data source.** Having Moz as the sole primary source removes the complexity of blending results from multiple APIs with different schemas, rate limits, and reliability characteristics. The Common Crawl fallback is narrow in scope — it only activates when Moz returns empty, not as a parallel enrichment layer.

- **Two-layer caching.** SQLite for Moz (persisted across restarts, multi-day TTLs) and in-memory for Common Crawl (cheap to re-fetch, session-scoped) is a sensible split. The TTLs are reasonable: domain authority changes slowly (24h is fine), backlink profiles change even slower (7d is fine).

- **Graceful degradation.** DB failure → cache disabled, server still runs. Moz failure on `get_domain_authority` → stale cache returned with a note. Moz empty on tools 2 & 3 → Common Crawl fallback. The server never hard-fails due to an external dependency being unavailable.

- **Stateless per-request server instances.** Creating a new `McpServer` per request is slightly wasteful on memory allocations, but it eliminates any possibility of state leaking between concurrent clients. For an MCP server where tool logic is entirely I/O-bound, this is the right trade-off.
