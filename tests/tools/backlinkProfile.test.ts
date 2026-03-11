// Tool tests: get_backlink_profile
// Uses InMemoryTransport + MCP Client to call the tool handler end-to-end.
// Happy path: github.com  |  Error path: invalid domain input

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Set env placeholders before any module that throws on missing env vars is loaded
process.env.OPEN_PAGERANK_API_KEY =
  process.env.OPEN_PAGERANK_API_KEY ?? "test-placeholder";
process.env.MOZ_ACCESS_ID = process.env.MOZ_ACCESS_ID ?? "test-placeholder";
process.env.MOZ_SECRET_KEY = process.env.MOZ_SECRET_KEY ?? "test-placeholder";
process.env.CTX_API_KEY = process.env.CTX_API_KEY ?? "test-placeholder";

const { createServer } = await import("../../src/server.js");

const hasRealPageRankKey =
  process.env.OPEN_PAGERANK_API_KEY !== "test-placeholder";

async function makeConnectedClient(): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, cleanup: () => client.close() };
}

function parseContent(
  result: Awaited<ReturnType<Client["callTool"]>>,
): unknown {
  const raw = result.content;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0] as { type: string; text?: string };
  if (first.type !== "text" || !first.text) return null;
  return JSON.parse(first.text);
}

describe("get_backlink_profile tool", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const pair = await makeConnectedClient();
    client = pair.client;
    cleanup = pair.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it.skipIf(!hasRealPageRankKey)(
    "happy path / fallback — returns an error containing Open PageRank data for github.com when backlinks are 0",
    async () => {
      const start = Date.now();
      const result = await client.callTool({
        name: "get_backlink_profile",
        arguments: { domain: "github.com", limit: 5 },
      });

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(30_000);

      // We expect isError to be true because 0 external backlinks forces a specific fallback layout
      expect(result.isError).toBeTruthy();
      const parsed = parseContent(result) as {
        error: boolean;
        message: string;
      };
      expect(parsed).toHaveProperty("error", true);
      expect(parsed.message).toContain("Open PageRank data is available");
    },
  );

  it("error path — returns parseable JSON for invalid domain, never crashes server", async () => {
    const result = await client.callTool({
      name: "get_backlink_profile",
      arguments: { domain: "!!not_a_domain!!" },
    });
    // Tool must never throw — always returns a content array
    expect(Array.isArray(result.content)).toBe(true);
    const parsed = parseContent(result);
    expect(parsed).toBeDefined();
  });

  it("accepts https:// prefix and strips it cleanly", async () => {
    // cleanDomain() strips protocol — should not crash regardless of API key
    const result = await client.callTool({
      name: "get_backlink_profile",
      arguments: { domain: "https://github.com/", limit: 5 },
    });
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    // Response must be parseable JSON
    const parsed = parseContent(result);
    expect(parsed).toBeDefined();
  });
});
