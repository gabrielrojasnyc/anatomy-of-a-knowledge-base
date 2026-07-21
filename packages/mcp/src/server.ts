import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type pg from "pg";
import { buildTools } from "@kb/core";

/**
 * Every tool here is LLM-free by design: buildTools gets no llm option, so
 * search runs retrieval through fusion and skips rerank. The MCP client
 * (Claude Code or any agent) is the orchestrator; this server only serves
 * evidence. That split is the point the blog makes about MCP.
 */
export function createKbServer(pool: pg.Pool, fixturesDir: string): McpServer {
  const server = new McpServer({
    name: "anatomy-of-a-knowledge-base",
    version: "1.0.0",
  });
  for (const tool of buildTools(pool, { fixturesDir })) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: {
          query: z.string().describe("What to look for"),
          project: z
            .string()
            .optional()
            .describe("Optional project scope: helios-eng or content"),
        },
      },
      async ({ query, project }) => {
        const rows = await tool.run({ query, project });
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      },
    );
  }
  return server;
}
