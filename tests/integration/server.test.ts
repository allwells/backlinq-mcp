// Integration test: full HTTP server via POST /mcp
// Boots the Express server on a random port and exercises the MCP endpoint.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

process.env.MOZ_ACCESS_ID = process.env.MOZ_ACCESS_ID ?? "test-placeholder";
process.env.MOZ_SECRET_KEY = process.env.MOZ_SECRET_KEY ?? "test-placeholder";
process.env.PORT = "0"; // OS assigns a free port

let server: http.Server | undefined;
let baseUrl: string;

async function postMcp(body: unknown): Promise<{ status: number; body: unknown }> {
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
          "Accept": "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => {
          // StreamableHTTP returns SSE (data: {...}\n\n) or plain JSON
          const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
          if (dataLine) {
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(dataLine.slice(5).trim()) });
              return;
            } catch { /* fall through to plain JSON */ }
          }
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
    const { default: express } = await import("express");
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const { createServer } = await import("../../src/server.js");

    const app = express();
    app.use(express.json());

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
          res.status(500).json({ error: true, code: "INTERNAL_ERROR", message });
        }
      }
    });

    app.get("/health", (_req, res) => {
      res.json({ status: "OK", service: "Backlinq MCP", version: "1.1.0" });
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

  it("GET /health returns 200 with status OK", async () => {
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
    expect((res.body as { status: string }).status).toBe("OK");
  });

  it("POST /mcp tools/list returns the 4 registered tools", async () => {
    const res = await postMcp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    // Accept 200 or 202; anything else means the server is broken
    expect([200, 202]).toContain(res.status);
    const tools = (res.body as { result: { tools: Array<{ name: string }> } })
      .result.tools;
    expect(Array.isArray(tools)).toBe(true);
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_domain_authority");
    expect(names).toContain("get_backlink_profile");
    expect(names).toContain("get_referring_domains");
    expect(names).toContain("compare_domains");
  });
});
