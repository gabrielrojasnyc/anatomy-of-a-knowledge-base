import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getPool } from "@kb/core";
import { createKbServer } from "./server.js";

const server = createKbServer(getPool(), join(process.cwd(), "fixtures"));
await server.connect(new StdioServerTransport());
