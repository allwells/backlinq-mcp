// MCP server setup with HTTP transport
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerBacklinkProfileTool } from "./tools/backlinkProfile.js";
import { registerDomainAuthorityTool } from "./tools/domainAuthority.js";
import { registerReferringDomainsTool } from "./tools/referringDomains.js";
import { registerCompareDomainsTool } from "./tools/compareDomains.js";
import type { Request, Response } from "express";

const PORT = Number(process.env.PORT) || 3000;

export function createServer(): McpServer {
  const server = new McpServer({
    name: "backlinq",
    version: "1.0.0",
  });

  registerDomainAuthorityTool(server);
  registerBacklinkProfileTool(server);
  registerReferringDomainsTool(server);
  registerCompareDomainsTool(server);

  return server;
}

export async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  // Stateless MCP handler — each request gets its own transport + server instance
  // This is safe because our tools are stateless (no shared mutable state)
  app.post("/mcp", async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    const server = createServer();

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[Backlinq] MCP request error: ${message}\n`);
      if (!res.headersSent) {
        res.status(500).json({ error: true, code: "INTERNAL_ERROR", message });
      }
    }
  });

  // Health check endpoint — used by Railway/Render to confirm the service is up
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "OK", service: "Backlinq MCP", version: "1.0.0" });
  });

  app.listen(PORT, () => {
    process.stderr.write(`Backlinq MCP server running on port ${PORT}\n`);
  });
}
