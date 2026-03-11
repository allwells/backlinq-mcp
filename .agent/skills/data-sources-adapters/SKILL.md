---
name: data-sources-adapters
description: Provides implementation patterns, API references, and typed interfaces for the three Backlinq data sources — Open PageRank, Moz API, and Common Crawl. Use when building or editing any file in src/adapters/ or src/types/index.ts. Do not use for MCP server registration, tool handlers, or deployment tasks.
---

# SKILL: Data Sources — Adapters for Backlinq

## When This Skill Is Active

Load when: building or editing any file in `src/adapters/`

---

## Overview of Data Sources

| Source        | What It Provides                   | Free?               | Rate Limit                   |
| ------------- | ---------------------------------- | ------------------- | ---------------------------- |
| Open PageRank | Domain PageRank score (0–10)       | Yes                 | 10 req/min                   |
| Moz API       | Domain Authority, Spam Score       | Free tier (limited) | 10 req/sec                   |
| Common Crawl  | Backlink URLs from web crawl index | Yes (public)        | No hard limit, be respectful |

---

## 1. Open PageRank API

**Base URL:** `https://openpagerank.com/api/v1.0/getPageRank`
**Docs:** https://www.domcop.com/openpagerank/documentation
**API Key:** Free at https://www.domcop.com/openpagerank/

```typescript
// src/adapters/openPageRank.ts
import type { OpenPageRankResponse, DomainRankResult } from "../types/index.js";

const BASE_URL = "https://openpagerank.com/api/v1.0/getPageRank";
const TIMEOUT_MS = 25_000;

export async function getDomainPageRank(
  domain: string,
): Promise<DomainRankResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = new URL(BASE_URL);
    url.searchParams.set("domains[]", domain);

    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        "API-OPR": process.env.OPEN_PAGERANK_API_KEY!,
      },
    });

    if (!response.ok) {
      throw new Error(`OpenPageRank API error: ${response.status}`);
    }

    const data: OpenPageRankResponse = await response.json();
    const result = data.response[0];

    return {
      domain: result.domain,
      pageRank: result.page_rank_decimal,
      rank: result.rank,
    };
  } finally {
    clearTimeout(timeout);
  }
}
```

**Types to add to `src/types/index.ts`:**

```typescript
export interface OpenPageRankResponse {
  status_code: number;
  response: Array<{
    domain: string;
    page_rank_integer: number;
    page_rank_decimal: number;
    rank: string;
  }>;
}

export interface DomainRankResult {
  domain: string;
  pageRank: number;
  rank: string;
}
```

---

## 2. Moz API (Free Tier)

**Base URL:** `https://lsapi.seomoz.com/v2/url_metrics`
**Docs:** https://moz.com/products/api/getting-started
**Auth:** Basic auth with `accessId:secretKey` (free tier: 10 req/month — use sparingly)

```typescript
// src/adapters/moz.ts
import type { MozMetricsResponse, MozDomainMetrics } from "../types/index.js";

const BASE_URL = "https://lsapi.seomoz.com/v2/url_metrics";
const TIMEOUT_MS = 25_000;

export async function getMozMetrics(domain: string): Promise<MozDomainMetrics> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const credentials = Buffer.from(
    `${process.env.MOZ_ACCESS_ID}:${process.env.MOZ_SECRET_KEY}`,
  ).toString("base64");

  try {
    const response = await fetch(BASE_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targets: [`https://${domain}/`],
        // Only request fields we actually need (saves quota)
        // da = domain authority, spam_score = spam score, links_in = backlinks
      }),
    });

    if (!response.ok) {
      throw new Error(`Moz API error: ${response.status}`);
    }

    const data: MozMetricsResponse = await response.json();
    const result = data.results[0];

    return {
      domain,
      domainAuthority: result.domain_authority,
      spamScore: result.spam_score,
      linksIn: result.links_in,
    };
  } finally {
    clearTimeout(timeout);
  }
}
```

**Types to add:**

```typescript
export interface MozMetricsResponse {
  results: Array<{
    domain_authority: number;
    spam_score: number;
    links_in: number;
  }>;
}

export interface MozDomainMetrics {
  domain: string;
  domainAuthority: number;
  spamScore: number;
  linksIn: number;
}
```

> ⚠️ Moz free tier is only 10 requests/month. Use it only in `get_domain_authority` and `compare_domains`. Do NOT call it in `get_backlink_profile` or `get_referring_domains`.

---

## 3. Common Crawl Index API

**Base URL:** `https://index.commoncrawl.org/CC-MAIN-2024-51-index`
**Docs:** https://index.commoncrawl.org/
**Auth:** None required

This API lets you search which URLs in Common Crawl link to a given domain by querying the CDX index.

```typescript
// src/adapters/commonCrawl.ts
import type { CommonCrawlRecord, BacklinkEntry } from "../types/index.js";

// Use latest crawl index — update this quarterly
const INDEX_URL = "https://index.commoncrawl.org/CC-MAIN-2024-51-index";
const TIMEOUT_MS = 25_000;

export async function getBacklinksFromCrawl(
  domain: string,
  limit: number = 10,
): Promise<BacklinkEntry[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // Query for pages that link TO this domain
    const url = new URL(INDEX_URL);
    url.searchParams.set("url", `*.${domain}/*`);
    url.searchParams.set("output", "json");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("fl", "url,timestamp,status,mime");

    const response = await fetch(url.toString(), {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Common Crawl API error: ${response.status}`);
    }

    // Common Crawl returns newline-delimited JSON
    const text = await response.text();
    const records: CommonCrawlRecord[] = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CommonCrawlRecord);

    return records.map((r) => ({
      url: r.url,
      timestamp: r.timestamp,
      status: r.status,
    }));
  } finally {
    clearTimeout(timeout);
  }
}
```

**Types to add:**

```typescript
export interface CommonCrawlRecord {
  url: string;
  timestamp: string;
  status: string;
  mime: string;
}

export interface BacklinkEntry {
  url: string;
  timestamp: string;
  status: string;
}
```

---

## Adapter Usage Map (Which Tool Uses Which Adapter)

| Tool                    | openPageRank | moz | commonCrawl |
| ----------------------- | ------------ | --- | ----------- |
| `get_backlink_profile`  | ✅           | ❌  | ✅          |
| `get_domain_authority`  | ✅           | ✅  | ❌          |
| `get_referring_domains` | ❌           | ❌  | ✅          |
| `compare_domains`       | ✅           | ✅  | ❌          |

---

## Error Handling Pattern for All Adapters

```typescript
// Never let adapter errors bubble up as raw exceptions
// Always throw a typed, descriptive Error
throw new Error(`[AdapterName] Failed to fetch data for ${domain}: ${detail}`);
```

Callers (tool handlers) will catch and format as structured MCP errors.
