# Backlinq MCP

Public-facing MCP (Model Context Protocol) server delivering Ahrefs/SEMrush-quality backlink intelligence at **$0.10/query** — no $1,200+/year subscriptions required.

Listed on the [CTX Protocol marketplace](https://ctxprotocol.com). MCP endpoint: `https://mcp.backlinq.dev/mcp`

---

## MCP Tools

| Tool                    | Input                              | Output                                          |
| ----------------------- | ---------------------------------- | ----------------------------------------------- |
| `get_domain_authority`  | `domain: string`                   | PageRank, Domain Authority, spam score          |
| `get_backlink_profile`  | `domain: string, limit?: number`   | Top backlinks, PageRank, referring domain count |
| `get_referring_domains` | `domain: string, limit?: number`   | Deduplicated referring domain list              |
| `compare_domains`       | `domainA: string, domainB: string` | Side-by-side authority metrics                  |

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

| Table                    | Data                                          | TTL      |
| ------------------------ | --------------------------------------------- | -------- |
| `domain_authority_cache` | DA, spam score, MozRank, link counts          | 24 hours |
| `backlink_cache`         | Individual backlink entries                   | 7 days   |
| `referring_domain_cache` | Referring domain list                         | 7 days   |
| `query_log`              | Per-query audit log (domain, tool, cache hit) | —        |

Cache hits are logged at `INFO` level. If Moz is unavailable and stale data exists for a domain, `get_domain_authority` returns the stale data with a `note` field in the response.

The database file path is configurable via `DB_PATH` (default: `./backlinq.db`). A DB failure at startup degrades gracefully — the server runs without caching rather than refusing to start.

To inspect cache hit rates from the command line:

```bash
bun run cache:stats
```

---

## Architecture

```
src/
├── index.ts              # Entry point — validates env, inits DB, starts server
├── server.ts             # McpServer setup + Express HTTP transport
├── database.ts           # SQLite cache layer (bun:sqlite)
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

---

## Health Check

```
GET /health
→ { "status": "OK", "service": "Backlinq MCP", "version": "1.1.0" }
```

---

## Data Sources

| Source       | Data                                                       | Cost |
| ------------ | ---------------------------------------------------------- | ---- |
| Moz API      | Domain Authority, Spam Score, backlinks, referring domains | Paid |
| Common Crawl | Backlinks, referring domains (fallback)                    | Free |
