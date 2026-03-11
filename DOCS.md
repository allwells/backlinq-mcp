# Backlinq — API & Agent Documentation

Backlinq is an MCP (Model Context Protocol) server designed to provide AI agents and human developers with high-level, real-time SEO and backlink intelligence.

The tools provided by this server synthesize data from Open PageRank, Moz, and the Common Crawl Index.

---

## Behavioral Guarantees for AI Agents

When interacting with Backlinq tools, agents can rely on the following behavioral guarantees:

1. **No Application Crashes:** A tool call will never crash the server. Internal API timeouts or invalid domains are caught gracefully.
2. **Predictable Types:** The server runs in strict TypeScript. Responses reliably match the defined schemas.
3. **Structured Errors for Self-Correction:** If an error occurs (e.g., an invalid domain name, or a rate limit is hit), the tool will return a successful transport response containing a JSON payload with `error: true`, an error `code`, and a human-readable `message`. You should parse this message and adjust your query (e.g., trying a different domain format) rather than assuming the system is broken.
4. **Speed:** All tools will resolve in under 30 seconds.

---

## Tool Reference

### 1. `get_domain_authority`

Fetches strict authority heuristics for a single domain.

- **Arguments:**
  - `domain` _(string | required)_: The target domain (e.g., `"nytimes.com"`). Automatically strips `https://` and `www.`.
- **Expected Success Response:**
  ```json
  {
    "domain": "nytimes.com",
    "pageRank": 8.47,
    "rank": "167",
    "domainAuthority": 95,
    "spamScore": 1
  }
  ```
- **When to use:** Use this when a user asks "how authoritative is X?" or "what is the reputation of Y?".

---

### 2. `get_backlink_profile`

Retrieves exact, ranking URLs that link to the target domain, drawing from the most recent Common Crawl index.

- **Arguments:**
  - `domain` _(string | required)_: The target domain.
  - `limit` _(number | optional | default: 10, max: 50)_: Maximum number of specific deep-links to return.
- **Expected Success Response:**
  ```json
  {
    "domain": "shopify.com",
    "pageRank": 7.5,
    "totalBacklinks": 14205,
    "referringDomainsCount": 845,
    "topBacklinks": [
      {
        "url": "https://example.com/best-ecommerce-platforms",
        "status": "200",
        "timestamp": "20241201123000"
      }
    ]
  }
  ```
- **When to use:** Use this when a user asks to see **specific URLs** or articles linking to a site.

---

### 3. `get_referring_domains`

Extracts unique root hostnames from the raw backlink graph.

- **Arguments:**
  - `domain` _(string | required)_: The target domain.
  - `limit` _(number | optional | default: 10, max: 100)_: Max number of unique root domains to return.
- **Expected Success Response:**
  ```json
  {
    "domain": "github.com",
    "totalFound": 50,
    "referringDomains": [
      {
        "domain": "stackoverflow.com",
        "exampleUrl": "https://stackoverflow.com/questions/.../...",
        "lastSeen": "20241201123000"
      }
    ]
  }
  ```
- **When to use:** Use this when a user asks "who is linking to X?" or wants a high-level view of a domain's networking base rather than specific deep-links.

---

### 4. `compare_domains`

Fetches authority metrics for two separate domains simultaneously and performs an analytical comparison.

- **Arguments:**
  - `domainA` _(string | required)_: The first domain (e.g., `"vercel.com"`).
  - `domainB` _(string | required)_: The second domain (e.g., `"netlify.com"`).
- **Expected Success Response:**
  ```json
  {
    "comparison": {
      "domainA": {
        "domain": "vercel.com",
        "pageRank": 7.3,
        "domainAuthority": 83,
        "spamScore": 1
      },
      "domainB": {
        "domain": "netlify.com",
        "pageRank": 7.1,
        "domainAuthority": 80,
        "spamScore": 2
      },
      "winner": "vercel.com",
      "summary": "vercel.com has slightly higher PageRank and Domain Authority."
    }
  }
  ```
- **When to use:** Use this for competitive intelligence when a user asks to compare two companies, websites, or brands.

---

## Data Sources

This server aggregates data from standard tier-1 SEO databases:

- **Open PageRank (`openpagerank.com`)**: Provides the 1-10 `pageRank` metric, calculated similarly to the historical Google PageRank formula using Common Crawl data.
- **Moz (`moz.com`)**: Provides `domainAuthority` (a 1-100 logarithmic scale predicting ranking ability) and `spamScore` (a 1-100 percentage likelihood of the site being penalized by search engines).
- **Common Crawl (`commoncrawl.org`)**: Provides raw `.wet` and `.cdx` index records of the live internet, which are parsed by Backlinq into structured backlink profiles.
