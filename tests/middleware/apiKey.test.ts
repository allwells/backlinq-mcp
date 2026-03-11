import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { apiKeyMiddleware } from "../../src/middleware/apiKey.js";

// ── Mock Prisma before importing the middleware ──────────────────────────────

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
const mockCreate = vi.fn();

vi.mock("../../src/lib/db.js", () => ({
  prisma: {
    apiKey: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
    usage: {
      create: (...args: unknown[]) => mockCreate(...args),
    },
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockReq(headers: Record<string, string> = {}): Request {
  return {
    headers,
    path: "/api/v1/domain-authority",
  } as unknown as Request;
}

function createMockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 0,
    _json: null as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: unknown) {
      res._json = data;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("apiKeyMiddleware", () => {
  const VALID_RAPIDAPI_SECRET = "test-rapidapi-secret-123";
  const originalEnv = process.env.RAPIDAPI_PROXY_SECRET;

  beforeEach(() => {
    process.env.RAPIDAPI_PROXY_SECRET = VALID_RAPIDAPI_SECRET;
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({});
    mockCreate.mockResolvedValue({});
  });

  afterEach(() => {
    process.env.RAPIDAPI_PROXY_SECRET = originalEnv;
  });

  it("passes through with valid RapidAPI secret (no DB call)", async () => {
    const req = createMockReq({
      "x-rapidapi-proxy-secret": VALID_RAPIDAPI_SECRET,
    });
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await apiKeyMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("returns 401 when RapidAPI header is present but wrong", async () => {
    const req = createMockReq({
      "x-rapidapi-proxy-secret": "wrong-secret",
    });
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await apiKeyMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ message: "Invalid API key" });
  });

  it("returns 401 when no auth headers are present", async () => {
    const req = createMockReq({});
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await apiKeyMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ message: "Missing authentication" });
  });

  it("passes through with valid self-service API key", async () => {
    mockFindUnique.mockResolvedValue({
      id: "key-1",
      userId: "user-1",
      active: true,
      currentUsage: 5,
      user: {
        subscription: { plan: "PRO" },
      },
    });

    const req = createMockReq({ "x-api-key": "bq_live_test123" });
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await apiKeyMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(mockFindUnique).toHaveBeenCalledOnce();
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "key-1" },
        data: expect.objectContaining({
          currentUsage: { increment: 1 },
        }),
      }),
    );
  });

  it("returns 401 for invalid API key (not found in DB)", async () => {
    mockFindUnique.mockResolvedValue(null);

    const req = createMockReq({ "x-api-key": "bq_live_invalid" });
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await apiKeyMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ message: "Invalid API key" });
  });

  it("returns 401 for revoked API key", async () => {
    mockFindUnique.mockResolvedValue({
      id: "key-2",
      userId: "user-2",
      active: false,
      currentUsage: 0,
      user: { subscription: null },
    });

    const req = createMockReq({ "x-api-key": "bq_live_revoked" });
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await apiKeyMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ message: "API key has been revoked" });
  });

  it("returns 429 when monthly quota is exceeded", async () => {
    mockFindUnique.mockResolvedValue({
      id: "key-3",
      userId: "user-3",
      active: true,
      currentUsage: 100,
      user: { subscription: null }, // FREE plan → 100 limit
    });

    const req = createMockReq({ "x-api-key": "bq_live_overlimit" });
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await apiKeyMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(429);
    expect(res._json).toMatchObject({
      message: "Monthly limit reached",
      upgradeUrl: "https://backlinq.dev/dashboard/billing",
    });
  });
});
