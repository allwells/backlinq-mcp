# Backlinq MCP

Public-facing MCP (Model Context Protocol) server delivering Ahrefs/SEMrush-quality backlink intelligence at **$0.10/query** — no $1,200+/year subscriptions required.

Listed on the [CTX Protocol marketplace](https://ctxprotocol.com). MCP endpoint: `https://mcp.backlinq.dev/mcp`

---

## MCP Tools

| Tool | Input | Output |
|------|-------|--------|
| `get_domain_authority` | `domain: string` | PageRank, Domain Authority, spam score |
| `get_backlink_profile` | `domain: string, limit?: number` | Top backlinks, PageRank, referring domain count |
| `get_referring_domains` | `domain: string, limit?: number` | Deduplicated referring domain list |
| `compare_domains` | `domains: string[]` | Side-by-side authority metrics (2–5 domains) |

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- API keys for data sources (Open PageRank, Moz)

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
# Open PageRank — https://www.domcop.com/openpagerank/
OPEN_PAGERANK_API_KEY=your_key_here

# Moz API — https://moz.com/products/api
MOZ_ACCESS_ID=your_access_id_here
MOZ_SECRET_KEY=your_secret_key_here

# CTX Protocol — https://ctxprotocol.com account dashboard
CTX_API_KEY=your_ctx_api_key_here

# DataForSEO (optional — enables richer backlink data)
DATAFORSEO_LOGIN=your_login_here
DATAFORSEO_PASSWORD=your_password_here

# Server port (default: 3000)
PORT=3000
```

### 3. Run locally

```bash
bun run dev
```

Server starts at `http://localhost:3001`. The MCP endpoint is `POST /mcp`.

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

## Architecture

```
src/
├── index.ts              # Entry point — validates env vars, calls startServer()
├── server.ts             # McpServer setup + Express HTTP transport
├── adapters/             # One file per external data source
│   ├── openPageRank.ts
│   ├── moz.ts
│   ├── commonCrawl.ts
│   └── dataForSeo.ts
├── tools/                # One file per MCP tool
│   ├── domainAuthority.ts
│   ├── backlinkProfile.ts
│   ├── referringDomains.ts
│   └── compareDomains.ts
├── types/
│   └── index.ts          # All shared TypeScript interfaces
└── utils/
    ├── validator.ts       # cleanDomain(), assertValidDomain()
    ├── formatter.ts       # Response formatting helpers
    └── logger.ts          # Structured logger (stderr only)
```

---

## Health Check

```
GET /health
→ { "status": "ok", "service": "backlinq", "version": "1.0.0" }
```

---

## Data Sources

| Source | Data | Cost |
|--------|------|------|
| Open PageRank | PageRank score (0–10) | Free |
| Moz API | Domain Authority, Spam Score | Paid |
| DataForSEO | Backlinks, referring domains (primary) | Paid |
| Common Crawl | Backlinks, referring domains (fallback) | Free |
