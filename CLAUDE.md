# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Backlinq API is a **Model Context Protocol (MCP) server** and **REST API** that provides SEO backlink intelligence via three data sources: Open PageRank, Moz, and Common Crawl. It is listed on CTX Protocol at `mcp.backlinq.dev/mcp` and priced at $0.10/query.

The server exposes four MCP tools and four REST endpoints, both protected by dual-auth middleware supporting RapidAPI gateway requests and direct self-service API keys issued by `backlinq.dev`.

## Commands

```bash
bun run dev          # Run directly with Bun (no build step)
bun run build        # Compile TypeScript → dist/
bun run start        # Run compiled output (node dist/index.js)
bun run typecheck    # tsc --noEmit — zero errors required before any phase is complete
bun test             # Run all tests (Vitest)
bun test tests/tools/backlinkProfile.test.ts  # Run single test file
```

## Architecture

```
src/
├── index.ts              # Entry point — validates env vars, calls startServer()
├── server.ts             # McpServer setup, Express routes, middleware registration
├── lib/
│   └── db.ts             # Prisma client singleton — import from here only
├── adapters/             # One file per external API
│   ├── openPageRank.ts
│   ├── moz.ts
│   ├── commonCrawl.ts
│   └── dataForSeo.ts     # Inactive — commented out until funded
├── middleware/
│   ├── apiKey.ts         # Dual auth — RapidAPI proxy secret + self-service API keys
│   └── rateLimit.ts      # IP-based rate limiting
├── routes/
│   └── api.ts            # REST route handlers
├── tools/                # One file per MCP tool
│   ├── domainAuthority.ts
│   ├── backlinkProfile.ts
│   ├── referringDomains.ts
│   └── compareDomains.ts
├── types/
│   └── index.ts          # ALL shared types — never define inline
└── utils/
    ├── validator.ts       # cleanDomain(), assertValidDomain(), extractRootDomain()
    ├── formatter.ts       # formatBacklinkProfile(), formatDomainComparison(), formatError()
    └── logger.ts          # Structured logger (stderr only — never stdout)

prisma/
└── schema.prisma          # Read-only mirror — never run migrate from this project
```

## Dual Auth Middleware

`src/middleware/apiKey.ts` handles all incoming requests to `/api/v1/*` and MCP endpoints. Auth is evaluated in this order:

```
1. X-RapidAPI-Proxy-Secret present → validate against env var → pass or 401
2. X-API-Key present               → hash + lookup in Supabase → quota check → increment + pass or 401/429
3. Neither present                 → 401 "Missing authentication"
```

RapidAPI requests skip internal metering. Self-service key requests are metered — usage is incremented atomically and written to the `Usage` table for dashboard analytics.

## Database

This project connects to the same Supabase instance as `backlinq-app` for API key validation and usage recording. Prisma is used for all queries.

**Critical rule:** This project NEVER runs `prisma migrate`. Schema ownership and all migrations belong to `backlinq-app` exclusively. Only run `bunx prisma generate` here after schema changes in `backlinq-app`.

## Environment Variables

```env
# Existing
OPEN_PAGERANK_API_KEY=   # domcop.com/openpagerank
MOZ_ACCESS_ID=           # moz.com/products/api
MOZ_SECRET_KEY=          # moz.com/products/api
PORT=                    # default 3000

# Auth
RAPIDAPI_PROXY_SECRET=   # Validated with timingSafeEqual — never string equality

# Database (added for self-service key validation)
DATABASE_URL=            # Supabase pooled connection — must include ?pgbouncer=true
DIRECT_URL=              # Supabase direct connection — for prisma generate only

# Optional / inactive
DATAFORSEO_LOGIN=
DATAFORSEO_PASSWORD=
CTX_API_KEY=
```

## Key Architectural Rules

- No business logic in `index.ts` — validates env vars and calls `startServer()` only
- No direct API calls in tool handlers — tools call adapters only
- No types defined inline — all interfaces belong in `src/types/index.ts`
- Error contract: every adapter throws a typed `Error`; every tool catches and returns `{ error: true, code: string, message: string }` — server never crashes
- 25-second timeout on every external API call (`AbortController`)
- Parallel fetches via `Promise.all` when data sources are independent
- Never write to stdout — MCP protocol uses stdout; all logs go to stderr via `logger.ts`
- Usage writes in middleware are non-blocking — wrapped in `.catch(() => null)`, never fail a request over analytics

## Naming Conventions

- Files: `camelCase.ts`
- Types/Interfaces: `PascalCase`
- Functions: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- MCP tool names: `snake_case`

## Skills

@.agent/skills/express-api-key-middleware/SKILL.md
