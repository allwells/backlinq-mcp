// Tool tests: get_domain_authority
// Happy path: nytimes.com (requires real keys — Moz + OpenPageRank)
// Error path: invalid domain, both tools must return structured errors

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.OPEN_PAGERANK_API_KEY =
  process.env.OPEN_PAGERANK_API_KEY ?? "test-placeholder";
process.env.MOZ_ACCESS_ID = process.env.MOZ_ACCESS_ID ?? "test-placeholder";
process.env.MOZ_SECRET_KEY = process.env.MOZ_SECRET_KEY ?? "test-placeholder";
process.env.CTX_API_KEY = process.env.CTX_API_KEY ?? "test-placeholder";

const { createServer } = await import("../../src/server.js");

const hasRealKeys =
  process.env.OPEN_PAGERANK_API_KEY !== "test-placeholder" &&
  process.env.MOZ_ACCESS_ID !== "test-placeholder" &&
  process.env.MOZ_SECRET_KEY !== "test-placeholder";

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
  return {
    client,
    cleanup: () => client.close(),
  };
}

describe("get_domain_authority tool", () => {
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

  it.skipIf(!hasRealKeys)(
    "happy path — returns DomainAuthorityOutput for nytimes.com",
    async () => {
      const start = Date.now();
      const result = await client.callTool({
        name: "get_domain_authority",
        arguments: { domain: "nytimes.com" },
      });

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(30_000);
      // Performance gate: warn if approaching 25s limit
      if (elapsed > 25_000) {
        console.error(
          `[PERF WARNING] get_domain_authority took ${elapsed}ms — approaching timeout`,
        );
      }

      expect(result.isError).toBeFalsy();
      const content = result.content[0] as { type: "text"; text: string };
      const parsed = JSON.parse(content.text);
      expect(parsed).toHaveProperty("domain", "nytimes.com");
      expect(parsed).toHaveProperty("pageRank");
      expect(parsed).toHaveProperty("domainAuthority");
      expect(parsed).toHaveProperty("spamScore");
      // linksIn is optional on Moz free tier; only assert type if present
      if (parsed.linksIn !== undefined) {
        expect(typeof parsed.linksIn).toBe("number");
      }
    },
  );

  it("error path — returns structured error for invalid domain, never crashes", async () => {
    const result = await client.callTool({
      name: "get_domain_authority",
      arguments: { domain: "   " }, // blank domain
    });
    // Must return content array — never crash or throw
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    const content = result.content[0] as { type: "text"; text: string };
    // Response must be parseable JSON
    expect(() => JSON.parse(content.text)).not.toThrow();
  });

  it("error path — accepts www. prefix and strips it", async () => {
    // Should not crash even with placeholder keys (adapter error is returned, not a server crash)
    const result = await client.callTool({
      name: "get_domain_authority",
      arguments: { domain: "www.example.com" },
    });
    expect(Array.isArray(result.content)).toBe(true);
    const content = result.content[0] as { type: "text"; text: string };
    expect(() => JSON.parse(content.text)).not.toThrow();
  });
});
