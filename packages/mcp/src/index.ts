import { existsSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getPool } from "@kb/core";
import { createKbServer } from "./server.js";

const fixturesDir = join(process.cwd(), "fixtures");
if (!existsSync(fixturesDir)) {
  console.error(
    "kb-mcp must run from the repo root (fixtures/ not found); use pnpm --dir /path/to/repo kb-mcp",
  );
  process.exit(1);
}

const server = createKbServer(getPool(), fixturesDir);
await server.connect(new StdioServerTransport());
