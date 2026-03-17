// Tool tests: get_referring_domains
// Happy path: shopify.com via Moz (requires real creds) or Common Crawl fallback
// Error paths: invalid domain, nonexistent domain

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MOZ_ACCESS_ID = process.env.MOZ_ACCESS_ID ?? "test-placeholder";
process.env.MOZ_SECRET_KEY = process.env.MOZ_SECRET_KEY ?? "test-placeholder";

const { createServer } = await import("../../src/server.js");

const hasMozCreds =
  process.env.MOZ_ACCESS_ID !== "test-placeholder" &&
  process.env.MOZ_SECRET_KEY !== "test-placeholder";

async function makeConnectedClient(): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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

  it.skipIf(!hasMozCreds)(
    "happy path — returns ReferringDomainsOutput for shopify.com",
    async () => {
      const start = Date.now();
      const result = await client.callTool({
        name: "get_referring_domains",
        arguments: { domain: "shopify.com", limit: 10 },
      });

      expect(Date.now() - start).toBeLessThan(30_000);
      expect(result.isError).toBeFalsy();

      const content = result.content[0] as { type: "text"; text: string };
      const parsed = JSON.parse(content.text) as Record<string, unknown>;
      expect(parsed).toHaveProperty("domain", "shopify.com");
      expect(parsed).toHaveProperty("totalFound");
      expect(parsed).toHaveProperty("referringDomains");
      expect(Array.isArray(parsed.referringDomains)).toBe(true);
    },
  );

  it("error path — invalid domain returns structured error, never crashes", async () => {
    const result = await client.callTool({
      name: "get_referring_domains",
      arguments: { domain: "not a domain at all!!!" },
    });
    expect(Array.isArray(result.content)).toBe(true);
    const content = result.content[0] as { type: "text"; text: string };
    expect(() => JSON.parse(content.text)).not.toThrow();
  });

  it("unknown domain returns empty result or structured error gracefully", async () => {
    const result = await client.callTool({
      name: "get_referring_domains",
      arguments: { domain: "this-domain-does-not-exist-xyz987abc.com", limit: 5 },
    });
    expect(Array.isArray(result.content)).toBe(true);
    const content = result.content[0] as { type: "text"; text: string };
    const parsed = JSON.parse(content.text) as Record<string, unknown>;
    const isEmptyResult =
      Array.isArray(parsed.referringDomains) &&
      (parsed.referringDomains as unknown[]).length === 0;
    const isStructuredError = parsed.error === true;
    expect(isEmptyResult || isStructuredError).toBe(true);
  });
});
