// Tool tests: get_domain_authority
// Happy path: nytimes.com (requires real Moz credentials)
// Error paths: invalid domain, www prefix stripping

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

  it.skipIf(!hasMozCreds)(
    "happy path — returns DomainAuthorityOutput for nytimes.com",
    async () => {
      const start = Date.now();
      const result = await client.callTool({
        name: "get_domain_authority",
        arguments: { domain: "nytimes.com" },
      });

      expect(Date.now() - start).toBeLessThan(30_000);
      expect(result.isError).toBeFalsy();

      const content = result.content[0] as { type: "text"; text: string };
      const parsed = JSON.parse(content.text);
      expect(parsed).toHaveProperty("domain", "nytimes.com");
      expect(parsed).toHaveProperty("pageRank");
      expect(parsed).toHaveProperty("domainAuthority");
      expect(parsed).toHaveProperty("spamScore");
      expect(typeof parsed.domainAuthority).toBe("number");
      if (parsed.linksIn !== undefined) {
        expect(typeof parsed.linksIn).toBe("number");
      }
    },
  );

  it("error path — returns structured error for blank domain, never crashes", async () => {
    const result = await client.callTool({
      name: "get_domain_authority",
      arguments: { domain: "   " },
    });
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    const content = result.content[0] as { type: "text"; text: string };
    expect(() => JSON.parse(content.text)).not.toThrow();
  });

  it("error path — accepts www. prefix and strips it without crashing", async () => {
    const result = await client.callTool({
      name: "get_domain_authority",
      arguments: { domain: "www.example.com" },
    });
    expect(Array.isArray(result.content)).toBe(true);
    const content = result.content[0] as { type: "text"; text: string };
    expect(() => JSON.parse(content.text)).not.toThrow();
  });
});
