# Backlinq MCP

Public-facing MCP (Model Context Protocol) server delivering Ahrefs/SEMrush-quality backlink intelligence at **$0.10/query** — no $1,200+/year subscriptions required.

Listed on the [CTX Protocol marketplace](https://ctxprotocol.com). MCP endpoint: `https://mcp.backlinq.dev/mcp`

---

## MCP Tools

| Tool                    | Input                              | Output                                                         |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------- |
| `get_domain_authority`  | `domain: string`                   | PageRank, Domain Authority, spam score                         |
| `get_backlink_profile`  | `domain: string, limit?: number`   | Top backlinks, PageRank, referring domain count + intelligence |
| `get_referring_domains` | `domain: string, limit?: number`   | Deduplicated referring domain list + intelligence              |
| `compare_domains`       | `domainA: string, domainB: string` | Side-by-side authority metrics + verdict                       |

### Response enrichment

Moz data is used to derive intelligence signals at no extra API cost:

- **`get_backlink_profile`** → `backlink_intelligence`: dofollow ratio, spam risk tier, top 5 anchor texts, authority distribution by DA bucket
- **`get_referring_domains`** → `referring_domain_intelligence`: average referring DA, high-authority domain count (DA > 60), dofollow domain ratio
- **`compare_domains`** → `verdict`: stronger authority, cleaner spam profile, plain-language summary

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- Moz API credentials — [moz.com/products/api](https://moz.com/products/api)

### 1. Clone and install

```bash
git clone https://github.com/allwells/backlinq-mcp.git
cd backlinq-mcp
bun install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in your keys:

```env
# Moz API — https://moz.com/products/api
MOZ_ACCESS_ID=your_access_id_here
MOZ_SECRET_KEY=your_secret_key_here

# Server port (default: 8000)
PORT=8000

# SQLite database path (default: ./backlinq.db)
DB_PATH=./backlinq.db
```

### 3. Run locally

```bash
bun run dev
```

Server starts at `http://localhost:8000`. The MCP endpoint is `POST /mcp`.

### 4. Build for production

```bash
bun run build
bun start
```

### 5. Run tests

```bash
bun test
```

### 6. Type check

```bash
bun run typecheck
```

---

## Caching

All Moz API responses are persisted to a local SQLite database (`bun:sqlite`) to avoid redundant API calls.

| Table                    | Data                                                         | TTL      |
| ------------------------ | ------------------------------------------------------------ | -------- |
| `domain_authority_cache` | DA, spam score, MozRank, link counts                         | 24 hours |
| `backlink_cache`         | Backlink entries with anchor text, source DA, link type      | 7 days   |
| `referring_domain_cache` | Referring domains with DA per domain                         | 7 days   |
| `query_log`              | Per-query audit log (domain, tool, cache hit)                | —        |
| `warm_cache_status`      | One-shot completion flag for the seed warm job               | —        |
| `moz_api_calls`          | Every Moz API call — endpoint, domain, status, response time | —        |

Cache hits are logged at `INFO` level. All tools serve stale cached data (with a `note` field) when the Moz hourly budget is approaching its limit or when Moz is unreachable.

The database file path is configurable via `DB_PATH` (default: `./backlinq.db`). A DB failure at startup degrades gracefully — the server runs without caching rather than refusing to start.

To inspect cache hit rates from the command line:

```bash
bun run cache:stats
```

## Rate Limit Budget

The server tracks every Moz API call in the `moz_api_calls` table and automatically backs off when approaching configured limits.

```env
MOZ_HOURLY_LIMIT=200   # default
MOZ_DAILY_LIMIT=2000   # default
```

At 80% of the hourly limit, tools switch to serving stale cache data rather than making new API calls. If no stale data exists for a domain, the live call proceeds regardless. Adjust the limits in `.env` to match your Moz plan.

## Background Jobs

Two jobs run in the server process to keep the cache warm:

- **Cache warmer** — runs once on first deployment, seeds DA data for ~1 000 well-known domains so fresh installs have populated caches immediately.
- **Preload job** — runs every 24 hours (first run 1 hour after startup), finds the top-500 cache-miss domains whose DA data expires within 6 hours, and refreshes them proactively.

---

## Architecture

```
src/
├── index.ts              # Entry point — validates env, inits DB, warms cache, starts server
├── server.ts             # McpServer setup + Express HTTP transport
├── database.ts           # SQLite cache layer (bun:sqlite)
├── rateLimit.ts          # Moz budget tracker — recordApiCall(), isApproachingLimit()
├── data/
│   └── seed-domains.ts   # ~1 000 well-known domains for cache warm job
├── jobs/
│   ├── warm-cache.ts     # One-shot seed job (runs once per deployment)
│   └── preload.ts        # 24 h refresh job (top-missed expiring domains)
├── cli/
│   └── stats.ts          # Cache statistics CLI (bun run cache:stats)
├── adapters/
│   ├── moz.ts            # Primary — url_metrics, /v2/links, /v2/linking_root_domains
│   └── commonCrawl.ts    # Fallback for backlinks + referring domains
├── tools/
│   ├── domainAuthority.ts
│   ├── backlinkProfile.ts
│   ├── referringDomains.ts
│   └── compareDomains.ts
├── types/
│   ├── index.ts          # All shared TypeScript interfaces
│   └── bun-sqlite.d.ts   # Type declarations for bun:sqlite built-in
└── utils/
    ├── validator.ts       # cleanDomain(), assertValidDomain()
    ├── formatter.ts       # Response formatting helpers
    ├── limiter.ts         # Async semaphore for Moz API concurrency control
    ├── cache.ts           # In-memory TTL cache (Common Crawl fallback)
    └── logger.ts          # Structured logger (stderr only)
```

For a detailed walkthrough of every layer — request lifecycle, adapter internals, caching strategy, rate limit design, background jobs, and enrichment computation — see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Health Check

```
GET /health
→ { "status": "OK", "service": "Backlinq MCP", "version": "1.2.0" }
```

---

## Data Sources

| Source       | Data                                                       | Cost |
| ------------ | ---------------------------------------------------------- | ---- |
| Moz API      | Domain Authority, Spam Score, backlinks, referring domains | Paid |
| Common Crawl | Backlinks, referring domains (fallback)                    | Free |
