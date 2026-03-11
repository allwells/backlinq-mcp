// Input validation helpers — pure functions, no side effects

import { z } from "zod";

const DOMAIN_REGEX =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

// Matches ANY bare IPv4 address
const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

// Matches IPv6 addresses (bracketed or bare, including ::1)
const IPV6_REGEX = /^\[?[0-9a-fA-F:]+\]?$/;

// Private / loopback IPv4 ranges
const PRIVATE_IPV4_REGEX = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** Single-word or reserved hostnames that are never valid public domains */
const INVALID_HOSTNAMES = new Set([
  "localhost",
  "local",
  "internal",
  "intranet",
  "home",
  "lan",
  "broadcasthost",
]);

const domainSchema = z.string().regex(DOMAIN_REGEX, "Invalid domain format");

export interface DomainValidationError {
  readonly error: true;
  readonly code: "INVALID_DOMAIN";
  readonly message: string;
}

/**
 * Strips protocol, www prefix, path, and query string. Lowercases the result.
 * e.g. "https://www.Example.com/path?q=1" → "example.com"
 */
export function cleanDomain(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "") // strip path, query string, and fragment
    .trim();
}

/**
 * Very basic sub-domain vs root domain detection.
 * If the domain has > 2 parts (e.g., docs.github.com), returns the last two (github.com).
 * This is naive (fails on co.uk) but sufficient for demo purposes and
 * basic fallback handling.
 */
export function extractRootDomain(cleanedDomain: string): string {
  const parts = cleanedDomain.split(".");
  if (parts.length > 2) {
    // In a real app we'd use `tldts` or `psl`. For now, grab the last two parts
    const tld = parts[parts.length - 1];

    // Quick hack for two-part TLDs like .co.uk or .com.au
    if (
      parts.length > 3 &&
      (tld === "uk" || tld === "au" || tld === "nz" || tld === "za") &&
      parts[parts.length - 2].length <= 3
    ) {
      return parts.slice(-3).join(".");
    }

    return parts.slice(-2).join(".");
  }
  return cleanedDomain;
}

/**
 * Returns true if the string is a valid, reachable public domain.
 *
 * Rejects (checked against the RAW input, before any cleaning):
 *   - Strings shorter than 4 characters (e.g. "a.b")
 *   - Reserved single-word hostnames (localhost, local, lan, …)
 *   - Bare IPv4 addresses (any range)
 *   - Private / loopback IPv4 ranges (127.x, 10.x, 192.168.x, 172.16-31.x)
 *   - IPv6 addresses (including ::1)
 *   - Strings with no dot (no TLD)
 *   - Anything that doesn't match the standard domain regex after cleaning
 *
 * NOTE: This function accepts the RAW user input so it can catch values like
 * "localhost" before cleanDomain() strips any protocol prefix.
 */
export function isValidDomain(raw: string): boolean {
  const lower = raw.toLowerCase().trim();

  // Minimum length guard — "a.b" is 3 chars and never a real public site
  if (lower.length < 4) {
    return false;
  }

  // Strip protocol/www/path to get at the bare hostname for further checks
  const cleaned = cleanDomain(lower);

  // Reject reserved single-word hostnames (checked BEFORE dot test so
  // "localhost" with or without a path is caught immediately)
  if (INVALID_HOSTNAMES.has(cleaned)) {
    return false;
  }

  // Reject single-label names (no dot = no TLD)
  if (!cleaned.includes(".")) {
    return false;
  }

  // Reject all IPv4 addresses
  if (IPV4_REGEX.test(cleaned)) {
    return false;
  }

  // Extra explicit check for private/loopback ranges even if the regex above
  // somehow misses edge cases
  if (PRIVATE_IPV4_REGEX.test(cleaned)) {
    return false;
  }

  // Reject IPv6 addresses (::1, [::1], 2001:db8::, etc.)
  if (IPV6_REGEX.test(cleaned)) {
    return false;
  }

  return DOMAIN_REGEX.test(cleaned);
}

/**
 * Throws an Error with a human-readable message if the raw domain string is
 * invalid. Call this BEFORE cleanDomain() in tool handlers so that values like
 * "localhost" are caught before they reach any adapter.
 */
export function assertValidDomain(raw: string): void {
  if (!isValidDomain(raw)) {
    throw new Error(
      `"${raw}" is not a valid public domain. Provide a real domain like "example.com". ` +
        `IP addresses, private ranges, localhost, and single-word names are not supported.`,
    );
  }
}

/**
 * Validates and returns a cleaned domain. Throws a zod error on invalid input.
 * @deprecated Prefer assertValidDomain() + cleanDomain() in tool handlers.
 */
export function validateDomain(domain: unknown): string {
  const cleaned = cleanDomain(String(domain));
  return domainSchema.parse(cleaned);
}

/** @deprecated Use cleanDomain() instead */
export function normalizeDomain(domain: string): string {
  return cleanDomain(domain);
}
