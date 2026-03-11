# Backlinq API — AI Agent Guide

## Project Overview

**Backlinq API** is a production MCP server and REST API providing SEO backlink intelligence. It aggregates data from three sources:

- **Open PageRank API** — Free domain authority scores (0–10)
- **Moz API** — Domain Authority (1–100), Spam Score (0–17), inbound links
- **Common Crawl Index API** — Raw backlink discovery from public crawl data

Four MCP tools exposed:

| Tool                    | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `get_domain_authority`  | DA/PR scores, spam score, inbound links         |
| `get_backlink_profile`  | Top backlinks, PageRank, referring domain count |
| `get_referring_domains` | Unique referring domains with authority         |
| `compare_domains`       | Side-by-side comparison of 2–5 domains          |

## Technology Stack

- **Runtime:** Node.js 20+ / Bun
- **Language:** TypeScript strict — no `any`
- **Module system:** ES Modules
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **HTTP:** Express + StreamableHTTPServerTransport
- **Database:** Prisma + Supabase (Postgres) — for API key validation only
- **Testing:** Vitest
- **Schema validation:** Zod
- **Deployment:** Render

## Commands

```bash
bun install
bun run dev           # Development
bun run typecheck     # Must pass zero errors before completing any work
bun run build         # Compile to dist/
bun run start         # Run compiled output
bun test              # All tests
bun test tests/tools/domainAuthority.test.ts  # Single file
```

## Project Structure

```
src/
├── index.ts              # Entry — validates env, starts server
├── server.ts             # MCP + Express setup, middleware registration
├── lib/
│   └── db.ts             # Prisma singleton — only import point
├── adapters/             # External API wrappers (one per source)
├── middleware/
│   ├── apiKey.ts         # Dual auth: RapidAPI + self-service keys
│   └── rateLimit.ts      # IP rate limiting
├── routes/api.ts         # REST route handlers
├── tools/                # MCP tool handlers (one per tool)
├── types/index.ts        # All shared TypeScript interfaces
└── utils/
    ├── validator.ts      # Domain validation
    ├── formatter.ts      # Response formatting
    └── logger.ts         # Structured logging (stderr only)

prisma/
└── schema.prisma         # Read-only mirror of backlinq-app schema
```

## Environment Variables

| Variable                | Required | Source                                            |
| ----------------------- | -------- | ------------------------------------------------- |
| `OPEN_PAGERANK_API_KEY` | Yes      | domcop.com/openpagerank                           |
| `MOZ_ACCESS_ID`         | Yes      | moz.com/products/api                              |
| `MOZ_SECRET_KEY`        | Yes      | moz.com/products/api                              |
| `RAPIDAPI_PROXY_SECRET` | Yes      | RapidAPI dashboard                                |
| `DATABASE_URL`          | Yes      | Supabase — pooled, must include `?pgbouncer=true` |
| `DIRECT_URL`            | Yes      | Supabase — direct, for `prisma generate` only     |
| `CTX_API_KEY`           | No       | ctxprotocol.com                                   |
| `DATAFORSEO_LOGIN`      | No       | Inactive adapter                                  |
| `DATAFORSEO_PASSWORD`   | No       | Inactive adapter                                  |
| `PORT`                  | No       | Default 3000                                      |

## Auth Middleware

All `/api/v1/*` and MCP endpoints pass through `src/middleware/apiKey.ts`. Evaluation order:

```
1. X-RapidAPI-Proxy-Secret → validate with timingSafeEqual → pass or 401
2. X-API-Key               → SHA-256 hash → Supabase lookup → quota check → increment → pass or 401/429
3. Neither present         → 401
```

RapidAPI requests bypass internal metering. Self-service key requests are metered atomically — `currentUsage` is incremented and a `Usage` row is written for dashboard analytics.

## Database Rules

This project shares the Supabase instance with `backlinq-app` for key validation only.

**Never run `prisma migrate` from this project.** All migrations are owned by `backlinq-app`. Only run `bunx prisma generate` here after schema changes land in `backlinq-app`.

## Tool Handler Pattern

```typescript
export function registerToolName(server: McpServer): void {
  server.registerTool(
    "tool_name",
    { inputSchema, outputSchema },
    async (args) => {
      try {
        assertValidDomain(args.domain);
        const domain = cleanDomain(args.domain);
        const [a, b] = await Promise.all([adapterA(domain), adapterB(domain)]);
        const output = {
          /* structured */
        };
        return {
          structuredContent: output as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const error = formatError("ERROR_CODE", message);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(error) }],
          isError: true,
        };
      }
    },
  );
}
```

## Architectural Rules

1. No business logic in `index.ts`
2. Tools call adapters only — no direct external calls
3. All types in `src/types/index.ts` — never inline
4. Every adapter throws typed `Error`; every tool catches and returns structured JSON
5. 25-second timeout on every external call (`AbortController`)
6. Parallel fetches via `Promise.all` when independent
7. Never write to stdout — stderr only via `logger.ts`
8. Usage writes are non-blocking — `.catch(() => null)` always

## Security

- `timingSafeEqual` on all secret comparisons — never `===`
- `assertValidDomain()` blocks private IPs, localhost, AWS metadata endpoint before any adapter call
- No stack traces in responses — structured error JSON only
- No secrets in logs, responses, or stdout

## Testing

- Happy path tests use real domains (`github.com`, `nytimes.com`)
- Error path tests verify structured error responses, never crashes
- Performance tests verify all tools complete under 30 seconds
- Real API tests only run when all three API keys are present in env

## Deployment

Render via `render.yaml`:

```yaml
buildCommand: bun install && bun run build
startCommand: node dist/index.js
healthCheckPath: /health
```

Health endpoint: `GET /health` → `{ "status": "ok" }`
