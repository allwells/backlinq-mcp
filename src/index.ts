// Entry point — validates environment and starts the MCP server
import "dotenv/config";
import { startServer } from "./server.js";
import { initDatabase } from "./database.js";
import { runCacheWarmer } from "./jobs/warm-cache.js";
import { startPreloadJob } from "./jobs/preload.js";

const REQUIRED_ENV_VARS = [
  "MOZ_ACCESS_ID",
  "MOZ_SECRET_KEY",
] as const;

function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        `Copy .env.example to .env and fill in the values.`,
    );
  }
}

async function main(): Promise<void> {
  validateEnv();
  initDatabase();
  await runCacheWarmer();
  await startServer();
  startPreloadJob();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[Backlinq] Fatal startup error: ${message}\n`);
  process.exit(1);
});
