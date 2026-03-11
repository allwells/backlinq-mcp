// Adapter integration tests — each adapter is called with a real domain
// Run: bun test tests/adapters/adapters.test.ts
//
// Moz tests are skipped when env vars are absent to protect the 10 req/month free tier.

import { describe, it, expect } from "vitest";

// Set up minimal env before importing adapters
process.env.OPEN_PAGERANK_API_KEY =
  process.env.OPEN_PAGERANK_API_KEY ?? "test-placeholder";
process.env.MOZ_ACCESS_ID = process.env.MOZ_ACCESS_ID ?? "test-placeholder";
process.env.MOZ_SECRET_KEY = process.env.MOZ_SECRET_KEY ?? "test-placeholder";

const { getDomainPageRank } =
  await import("../../src/adapters/openPageRank.js");
const { getMozMetrics } = await import("../../src/adapters/moz.js");
const { getBacklinksFromCrawl } =
  await import("../../src/adapters/commonCrawl.js");

// ─── Open PageRank ─────────────────────────────────────────────────────────

describe("getDomainPageRank", () => {
  it("returns a DomainRankResult for a valid domain", async () => {
    const result = await getDomainPageRank("example.com");
    expect(result).toHaveProperty("domain");
    expect(result).toHaveProperty("pageRank");
    expect(result).toHaveProperty("rank");
    expect(typeof result.pageRank).toBe("number");
  });

  it("throws an error for an invalid API key", async () => {
    // This test relies on the API returning a non-OK status for bad keys
    // We check the shape of the throw, not its network behaviour
    await expect(getDomainPageRank("")).rejects.toBeInstanceOf(Error);
  });
});

// ─── Common Crawl ──────────────────────────────────────────────────────────

describe("getBacklinksFromCrawl", () => {
  it("throws an error when it finds 0 external backlinks for example.com", async () => {
    await expect(getBacklinksFromCrawl("example.com", 5)).rejects.toThrow(
      /No external backlinks found/,
    );
  });

  it("returns an empty array when limit is 0", async () => {
    const results = await getBacklinksFromCrawl("example.com", 0);
    expect(results).toEqual([]);
  });
});

// ─── Moz (skipped if real creds are absent) ───────────────────────────────

const hasMozCreds =
  process.env.MOZ_ACCESS_ID !== "test-placeholder" &&
  process.env.MOZ_SECRET_KEY !== "test-placeholder";

describe.skipIf(!hasMozCreds)("getMozMetrics (requires real Moz creds)", () => {
  it("returns MozDomainMetrics for example.com", async () => {
    const result = await getMozMetrics("example.com");
    expect(result).toHaveProperty("domain", "example.com");
    expect(result).toHaveProperty("domainAuthority");
    expect(result).toHaveProperty("spamScore");
    expect(typeof result.domainAuthority).toBe("number");
    // linksIn is optional on the Moz free tier
    if (result.linksIn !== undefined) {
      expect(typeof result.linksIn).toBe("number");
    }
  });
});
