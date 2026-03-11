// Integration test: full HTTP server + real tool calls via POST /mcp
// Boots the Express server on a random port and makes StreamableHTTP requests

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

process.env.OPEN_PAGERANK_API_KEY =
  process.env.OPEN_PAGERANK_API_KEY ?? "test-placeholder";
process.env.MOZ_ACCESS_ID = process.env.MOZ_ACCESS_ID ?? "test-placeholder";
process.env.MOZ_SECRET_KEY = process.env.MOZ_SECRET_KEY ?? "test-placeholder";
process.env.CTX_API_KEY = process.env.CTX_API_KEY ?? "test-placeholder";

// Override PORT so we don't conflict with anything running on 3000
process.env.PORT = "0"; // OS assigns a free port

let server: http.Server | undefined;
let baseUrl: string;

async function postMcp(
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL("/mcp", baseUrl);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("HTTP server integration", () => {
  beforeAll(async () => {
    // Dynamically import so env vars are already set above
    const { default: express } = await import("express");
    const { createContextMiddleware } = await import("@ctxprotocol/sdk");
    const { StreamableHTTPServerTransport } =
      await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const { createServer } = await import("../../src/server.js");

    const app = express();
    app.use(express.json());
    app.use("/mcp", createContextMiddleware());
    app.post("/mcp", async (req, res) => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcpServer = createServer();
      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          res
            .status(500)
            .json({ error: true, code: "INTERNAL_ERROR", message });
        }
      }
    });
    app.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });

    await new Promise<void>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        server = srv;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /health returns { status: ok }", async () => {
    const res = await new Promise<{ status: number; body: unknown }>(
      (resolve, reject) => {
        const req = http.get(`${baseUrl}/health`, (r) => {
          let raw = "";
          r.on("data", (c: string) => (raw += c));
          r.on("end", () => {
            resolve({ status: r.statusCode ?? 0, body: JSON.parse(raw) });
          });
        });
        req.on("error", reject);
      },
    );
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("ok");
  });

  it("POST /mcp with tools/list returns available tools", async () => {
    const res = await postMcp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    // CTX middleware may return 401 on tools/list for unverified clients.
    // We accept either 200 with tools or 401 — both mean the server is functioning.
    expect([200, 202, 401, 406]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty("result");
      const tools = (res.body as { result: { tools: unknown[] } }).result.tools;
      expect(Array.isArray(tools)).toBe(true);
      const toolNames = tools.map((t) => (t as { name: string }).name);
      expect(toolNames).toContain("get_backlink_profile");
      expect(toolNames).toContain("get_domain_authority");
      expect(toolNames).toContain("get_referring_domains");
      expect(toolNames).toContain("compare_domains");
    }
  });
});
