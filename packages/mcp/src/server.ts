import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type pg from "pg";
import { buildTools, type ToolParam } from "@kb/core";

/**
 * Every tool here is LLM-free by design: buildTools gets no llm option, so
 * search runs retrieval through fusion and skips rerank. The MCP client
 * (Claude Code or any agent) is the orchestrator; this server only serves
 * evidence. That split is the point the blog makes about MCP.
 *
 * Each tool's input schema is generated from the params it declares in
 * @kb/core, so the schema an agent reads is the contract the code enforces:
 * no advertised-but-ignored parameters, no required-but-unused ones.
 */
export async function createKbServer(
  pool: pg.Pool,
  fixturesDir: string,
): Promise<McpServer> {
  const { rows } = await pool.query(`SELECT name FROM projects ORDER BY name`);
  const projectNames = rows.map((r) => r.name as string).join(", ");

  const toZod = (p: ToolParam): z.ZodTypeAny => {
    const base =
      p.name === "limit"
        ? z
            .number()
            .int()
            .min(1)
            .max(p.max ?? 20)
        : z.string();
    const description =
      p.name === "project" && projectNames.length > 0
        ? `${p.description}: ${projectNames}`
        : p.description;
    return (p.required ? base : base.optional()).describe(description);
  };

  const server = new McpServer({
    name: "anatomy-of-a-knowledge-base",
    version: "1.0.0",
  });
  for (const tool of buildTools(pool, { fixturesDir })) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: Object.fromEntries(
          tool.params.map((p) => [p.name, toZod(p)]),
        ),
      },
      async (args) => {
        const rows = await tool.run(args ?? {});
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      },
    );
  }
  return server;
}
