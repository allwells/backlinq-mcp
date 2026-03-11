---
name: mcp-server-building
description: Provides patterns and best practices for building MCP (Model Context Protocol) servers using @modelcontextprotocol/sdk and TypeScript. Use when creating or editing server.ts, index.ts, or any file in src/tools/. Do not use for adapter, utility, or deployment tasks.
---

# SKILL: Building MCP Servers with @modelcontextprotocol/sdk

## When This Skill Is Active

Load this skill when: building, editing, or debugging any MCP server file (`server.ts`, `tools/`, `index.ts`)

---

## Core Concepts

**MCP (Model Context Protocol)** is Anthropic's standard for AI agents to call external tools. An MCP server exposes named tools with defined input/output schemas. Agents discover and call them automatically.

---

## Project-Specific Server Setup

```typescript
// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "backlinq",
    version: "1.0.0",
  });

  // Register tools here (see Tool Pattern below)

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Backlinq MCP server running"); // stderr only, never stdout
}
```

```typescript
// src/index.ts
import { startServer } from "./server.js";

startServer().catch((err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});
```

---

## Tool Registration Pattern

```typescript
server.tool(
  "get_backlink_profile", // snake_case name
  "Returns backlink profile for a domain", // clear description for agent discovery
  {
    domain: z.string().describe("The domain to analyze, e.g. example.com"),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Max backlinks to return"),
  },
  async ({ domain, limit }): Promise<ToolResult> => {
    try {
      const result = await getBacklinkProfile(domain, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: true,
              code: "FETCH_FAILED",
              message: err instanceof Error ? err.message : "Unknown error",
            }),
          },
        ],
        isError: true,
      };
    }
  },
);
```

---

## The 4 Tools for Backlinq

### Tool 1: `get_backlink_profile`

- **Input:** `domain: string`
- **Output:** `{ domain, totalBacklinks, referringDomains, domainRating, topBacklinks: BacklinkEntry[] }`
- **Adapters used:** `openPageRank` + `commonCrawl`

### Tool 2: `get_domain_authority`

- **Input:** `domain: string`
- **Output:** `{ domain, pageRank, mozDomainAuthority, spamScore, trend }`
- **Adapters used:** `openPageRank` + `moz`

### Tool 3: `get_referring_domains`

- **Input:** `domain: string, limit?: number`
- **Output:** `{ domain, referringDomains: ReferringDomain[] }`
- **Adapters used:** `commonCrawl`

### Tool 4: `compare_domains`

- **Input:** `domainA: string, domainB: string`
- **Output:** `{ comparison: DomainComparison }` (side-by-side metrics)
- **Adapters used:** `openPageRank` + `moz` (called in parallel via `Promise.all`)

---

## Critical MCP Rules

- **Never write to stdout** except via MCP response. Use `console.error` for all logging
- **outputSchema must match actual response shape** — CTX Protocol validates this
- **Every tool must respond in under 30 seconds** — use 25s timeouts on all API calls
- **Return structured errors** — never throw from a tool handler, always return `isError: true` with JSON body
- Tools must be **stateless** — no shared mutable state between tool calls

---

## Input Validation Pattern (Zod)

```typescript
// Always strip protocol from domains
const cleanDomain = (domain: string): string =>
  domain
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .toLowerCase();
```

---

## Running Locally

```bash
npx tsx src/index.ts
```

---

## Common Errors & Fixes

| Error                 | Cause                                    | Fix                                             |
| --------------------- | ---------------------------------------- | ----------------------------------------------- |
| `Cannot find module`  | Missing `.js` extension on local imports | Add `.js` to all local imports: `"./server.js"` |
| Agent loops / retries | Vague tool description                   | Make tool description more specific             |
| Timeout               | Sequential API calls                     | Use `Promise.all` for parallel calls            |
| Schema mismatch       | outputSchema ≠ actual response           | Match schema exactly to what you return         |
