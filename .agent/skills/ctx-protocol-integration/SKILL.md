---
name: ctx-protocol-integration
description: Provides integration patterns for the CTX Protocol marketplace SDK, tool registration, USDC payment setup, and deployment. Use when integrating @ctxprotocol/sdk, registering tools on ctxprotocol.com, handling deployment, or submitting tools for grant verification. Do not use for MCP server logic or adapter code.
---

# SKILL: CTX Protocol Integration

## When This Skill Is Active

Load when: integrating `@ctxprotocol/sdk`, registering tools on the marketplace, handling USDC payments, or deploying to CTX.

---

## What CTX Protocol Does

CTX Protocol is the marketplace layer on top of your MCP server. It:

- Routes AI agent requests to your tool
- Handles USDC micropayments ($0.10/query)
- Pays you 90% of every query fee
- Verifies your tool quality before activating payments

---

## SDK Installation

```bash
npm install @ctxprotocol/sdk @modelcontextprotocol/sdk
```

---

## Integration Pattern

CTX Protocol wraps your existing MCP server. Minimal changes to `server.ts`:

```typescript
import { CTXProtocol } from "@ctxprotocol/sdk";

const ctx = new CTXProtocol({
  apiKey: process.env.CTX_API_KEY!, // from ctxprotocol.com account
});

// Pass your MCP server through CTX
await ctx.serve(server, {
  port: Number(process.env.PORT) || 3000,
});
```

Check the official docs at https://docs.ctxprotocol.com/guides/build-tools for the latest SDK API — it may have changed.

---

## Environment Variables Required

```env
CTX_API_KEY=your_ctx_api_key_here
MOZ_ACCESS_ID=your_moz_access_id
MOZ_SECRET_KEY=your_moz_secret_key
OPEN_PAGERANK_API_KEY=your_open_pagerank_key
PORT=3000
```

---

## Registration Steps (Phase 4)

1. Sign in at `ctxprotocol.com` → copy your **Smart Wallet Address**
2. Go to `ctxprotocol.com/contribute`
3. Paste your deployed HTTPS endpoint URL
4. Use the [MCP Server Analysis Prompt](https://github.com/ctxprotocol/sdk/blob/main/docs/mcp-server-analysis-prompt.md) to auto-generate name, description, category
5. **Set price to `$0`** initially — required for testing
6. Add stake to activate

---

## Testing on CTX (Phase 5)

1. Enable **Developer Mode**: Settings → Developer Settings → Toggle on
2. Run test queries against your tool in the CTX chat interface
3. Click **Copy All** on developer logs
4. Feed logs + your MCP server code to Antigravity: _"Fix these errors in my MCP server"_
5. Goal: zero self-correcting loops, clean structured responses

---

## Quality Requirements to Get Paid

| Requirement       | Detail                                     |
| ----------------- | ------------------------------------------ |
| Schema validation | `outputSchema` must match actual responses |
| Response time     | Under 30 seconds always                    |
| Uptime            | 95%+ for 30 days (for second $500 payment) |
| Error handling    | Structured JSON errors, never raw crashes  |

---

## Submitting for Review (Phase 6)

Email [email protected] with:

- Tool name + endpoint URL
- 3–5 test questions that exercise all tools
- Expected answer for each question

**Example test questions for LinkScope:**

1. "What is the domain authority of nytimes.com?"
2. "Show me the top 10 backlinks pointing to shopify.com"
3. "List referring domains for github.com"
4. "Compare the backlink profiles of vercel.com and netlify.com"
5. "What is the spam score for a suspicious domain like example-spam-site.biz?"

---

## Common Issues

| Issue                 | Fix                                            |
| --------------------- | ---------------------------------------------- |
| Tool not discovered   | Check tool descriptions are clear and specific |
| Agent loops           | Simplify output — return less nesting          |
| Payment not triggered | Ensure price is set to non-zero after testing  |
| Verification fails    | Re-check outputSchema matches response exactly |
