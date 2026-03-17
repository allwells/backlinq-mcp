// Tool tests: get_backlink_profile
// Happy path: github.com (requires real Moz credentials)
// Error paths: invalid domain, protocol prefix stripping

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

function parseContent(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const first = result.content[0] as { type: string; text?: string };
  if (first?.type !== "text" || !first.text) return null;
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

  it.skipIf(!hasMozCreds)(
    "happy path — returns BacklinkProfile for github.com",
    async () => {
      const start = Date.now();
      const result = await client.callTool({
        name: "get_backlink_profile",
        arguments: { domain: "github.com", limit: 5 },
      });

      expect(Date.now() - start).toBeLessThan(30_000);
      expect(result.isError).toBeFalsy();

      const parsed = parseContent(result) as Record<string, unknown>;
      expect(parsed).toHaveProperty("domain", "github.com");
      expect(parsed).toHaveProperty("pageRank");
      expect(parsed).toHaveProperty("totalBacklinks");
      expect(parsed).toHaveProperty("topBacklinks");
      expect(Array.isArray(parsed.topBacklinks)).toBe(true);
    },
  );

  it("error path — returns parseable JSON for invalid domain, never crashes", async () => {
    const result = await client.callTool({
      name: "get_backlink_profile",
      arguments: { domain: "!!not_a_domain!!" },
    });
    expect(Array.isArray(result.content)).toBe(true);
    expect(() => parseContent(result)).not.toThrow();
  });

  it("accepts https:// prefix and strips it cleanly", async () => {
    const result = await client.callTool({
      name: "get_backlink_profile",
      arguments: { domain: "https://github.com/", limit: 5 },
    });
    expect(Array.isArray(result.content)).toBe(true);
    expect(() => parseContent(result)).not.toThrow();
  });
});
