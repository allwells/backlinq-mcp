// Adapter tests — Moz and Common Crawl
// Moz tests are skipped when real credentials are absent.

import { describe, it, expect } from "vitest";

process.env.MOZ_ACCESS_ID = process.env.MOZ_ACCESS_ID ?? "test-placeholder";
process.env.MOZ_SECRET_KEY = process.env.MOZ_SECRET_KEY ?? "test-placeholder";

const { getMozMetrics } = await import("../../src/adapters/moz.js");
const { getBacklinksFromCrawl } = await import("../../src/adapters/commonCrawl.js");

// ─── Common Crawl ─────────────────────────────────────────────────────────────

describe("getBacklinksFromCrawl", () => {
  it("throws when no external backlinks are found for example.com", async () => {
    await expect(getBacklinksFromCrawl("example.com", 5)).rejects.toThrow(
      /No external backlinks found/,
    );
  });

  it("returns an empty array when limit is 0", async () => {
    const results = await getBacklinksFromCrawl("example.com", 0);
    expect(results).toEqual([]);
  });
});

// ─── Moz (skipped without real credentials) ───────────────────────────────────

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
    if (result.linksIn !== undefined) {
      expect(typeof result.linksIn).toBe("number");
    }
  });

  it("accepts a batch of domains", async () => {
    const results = await getMozMetrics(["example.com", "github.com"]);
    expect(results).toHaveLength(2);
    expect(results[0]).toHaveProperty("domain", "example.com");
    expect(results[1]).toHaveProperty("domain", "github.com");
  });
});
