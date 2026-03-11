# Backlinq API — SEO Backlink Intelligence Server

Production-grade API server that delivers Ahrefs/SEMrush-quality backlink data at **$0.10/query** — no $1,200+/year subscriptions required.

Serves both MCP (Model Context Protocol) clients and REST API consumers. Listed on the [CTX Protocol marketplace](https://ctxprotocol.com).

---

## Features

- **Dual Interface**: MCP tools for AI agents + REST endpoints for developers
- **Multiple Auth Methods**: 
  - RapidAPI proxy secret (for RapidAPI consumers)
  - Self-service API keys (for direct consumers)
  - Internal service auth (for trusted services like the playground)
- **Quota Management**: Per-key usage tracking with plan-based limits
- **Usage Logging**: Request history for dashboard analytics

---

## API Endpoints

| Endpoint | Method | Description | Auth |
|----------|--------|-------------|------|
| `/api/domain-authority` | GET | DA score (0-100), PageRank (0-10), spam score | API Key or RapidAPI |
| `/api/backlink-profile` | GET | Total backlinks, referring domains, top URLs | API Key or RapidAPI |
| `/api/referring-domains` | GET | Deduplicated referring domains list | API Key or RapidAPI |
| `/api/compare-domains` | GET | Side-by-side comparison for 2-5 domains | API Key or RapidAPI |
| `/mcp` | POST | MCP tool interface for AI agents | None (stateless) |
| `/health` | GET | Health check | None |

---

## MCP Tools Exposed

| Tool Name | Input | Output |
|-----------|-------|--------|
| `get_domain_authority` | `domain: string` | PageRank, DA, spam score, links |
| `get_backlink_profile` | `domain: string, limit?: number` | PageRank, backlinks, referring domains |
| `get_referring_domains` | `domain: string, limit?: number` | Unique referring domains |
| `compare_domains` | `domains: string[]` | Side-by-side metrics, ranked leaderboard |

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) >= 1.0 installed
- PostgreSQL database (shared with backlinq-app for API key validation)
- API keys for data sources (Open PageRank, Moz)

### 1. Clone the repository

```bash
git clone https://github.com/allwells/backlinq-api.git
cd backlinq-api
```

### 2. Install dependencies

```bash
bun install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in your API keys:

```env
# CTX Protocol API Key — obtain from ctxprotocol.com account dashboard
CTX_API_KEY=your_ctx_api_key_here

# Open PageRank API Key — obtain from https://www.domcop.com/openpagerank/
OPEN_PAGERANK_API_KEY=your_open_pagerank_api_key_here

# Moz API Credentials — obtain from https://moz.com/products/api
MOZ_ACCESS_ID=your_moz_access_id_here
MOZ_SECRET_KEY=your_moz_secret_key_here
MOZ_API_TOKEN=your_moz_api_token

# DataForSEO API Credentials (optional, currently inactive)
DATAFORSEO_LOGIN=your_login_here
DATAFORSEO_PASSWORD=your_password_here

# RapidAPI Proxy Secret — from RapidAPI dashboard → My APIs → Security
# When set, all /api/* requests must include X-RapidAPI-Proxy-Secret header
RAPIDAPI_PROXY_SECRET=your_proxy_secret_here

# Internal Service Secret — shared secret for trusted internal services
# (e.g., the playground) to authenticate with this API server.
# Must match INTERNAL_SERVICE_SECRET in backlinq-app.
# Generate with: openssl rand -hex 32
INTERNAL_SERVICE_SECRET=your_internal_service_secret_here

# Database — PostgreSQL (shared with backlinq-app for API key validation)
# For local development:
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/backlinq?pgbouncer=true
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/backlinq

# For Supabase (production):
# DATABASE_URL=postgresql://postgres.[PROJECT_ID]:[PASSWORD]@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?pgbouncer=true
# DIRECT_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT_ID].supabase.co:5432/postgres

# Server port (default: 3000)
PORT=3000
```

### 4. Set up the database

The API server shares the database with backlinq-app. Ensure the same DATABASE_URL is used in both projects.

Run migrations from backlinq-app:
```bash
cd ../backlinq-app
bun run db:migrate
```

### 5. Run locally (development)

```bash
bun run dev
```

Runs `src/index.ts` directly via Bun — no build step required.

The server will start on `http://localhost:3000` (or the port specified in PORT).

### 6. Build for production

```bash
bun run build
bun start
```

### 7. Run tests

```bash
bun test
```

### 8. Type check

```bash
bun run typecheck
```

---

## Architecture

```
src/
├── index.ts              # Entry point — validates env vars, calls startServer()
├── server.ts             # Express server setup, middleware, route mounting
├── routes/
│   └── api.ts            # REST API route handlers (domain-authority, etc.)
├── middleware/
│   ├── apiKey.ts         # Unified auth: RapidAPI, self-service, internal
│   └── rateLimit.ts      # Rate limiting middleware
├── adapters/             # External API integrations
│   ├── openPageRank.ts   # Fetches PageRank score
│   ├── moz.ts            # Fetches Domain Authority + spam score
│   ├── commonCrawl.ts    # Queries CDX index for backlinks
│   └── dataForSeo.ts     # Inactive — commented out until funded
├── tools/                # MCP tool implementations
│   ├── domainAuthority.ts
│   ├── backlinkProfile.ts
│   ├── referringDomains.ts
│   └── compareDomains.ts
├── lib/
│   └── db.ts             # Prisma client singleton
├── types/
│   └── index.ts          # Shared TypeScript interfaces
└── utils/
    ├── validator.ts      # Domain validation helpers
    ├── formatter.ts      # Response formatting
    └── logger.ts         # Structured logging
```

---

## Authentication Methods

### 1. RapidAPI Proxy (External Consumers)

```http
GET /api/domain-authority?domain=example.com
X-RapidAPI-Proxy-Secret: your_rapidapi_secret
```

Used when requests come through RapidAPI's proxy. No API key required.

### 2. Self-Service API Key (Direct Consumers)

```http
GET /api/domain-authority?domain=example.com
X-API-Key: bq_live_xxxxxxxx...
```

Uses SHA-256 hashed API keys stored in the database. Quota is checked and incremented.

### 3. Internal Service Auth (Playground)

```http
GET /api/domain-authority?domain=example.com
X-Internal-Service-Secret: shared_secret
X-API-Key-Hash: sha256_hash_of_key
```

Used by the backlinq-app playground. Validates both the internal secret and the user's API key hash.

---

## Data Sources

| Source | Data Provided | Cost |
|--------|---------------|------|
| **Open PageRank API** | PageRank scores (0-10) | Free |
| **Moz API** | Domain Authority, Spam Score | Free tier |
| **Common Crawl Index** | Backlink discovery | Free, public |

---

## Quota System

| Plan | Monthly Limit |
|------|---------------|
| Free | 100 requests |
| Pro | 5,000 requests |
| Ultra | 25,000 requests |

Quota is tracked per API key. When exceeded, the API returns:

```json
{
  "error": true,
  "code": "QUOTA_EXCEEDED",
  "message": "Monthly limit reached",
  "upgradeUrl": "https://backlinq.dev/dashboard/billing"
}
```

---

## Integration with backlinq-app

This API server works in tandem with the [backlinq-app](https://github.com/allwells/backlinq-app):

1. **Database**: Both share the same PostgreSQL database for user/subscription/key data
2. **Authentication**: backlinq-app manages API keys; this server validates them
3. **Playground**: backlinq-app's playground uses internal service auth to proxy requests
4. **Usage Logging**: Requests are logged to the `Usage` table for dashboard display

---

## Deployment

Designed for deployment on [Railway](https://railway.app) or [Render](https://render.com).

1. Push to GitHub
2. Connect your repo to Railway/Render
3. Set environment variables in the platform dashboard
4. Deploy — the server will start automatically

**Health Check**: The `/health` endpoint returns `200 OK` with:
```json
{ "status": "ok", "service": "backlinq", "version": "1.0.0" }
```

---

## Related Projects

- [backlinq-app](https://github.com/allwells/backlinq-app) — The web dashboard and marketing site

---

## License

MIT
