import { join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  askStream,
  buildTools,
  chat,
  getPool,
  loadConfig,
  search,
} from "@kb/core";

const pool = getPool();
const FIXTURES = join(process.cwd(), "fixtures");

const llm = (() => {
  const cfg = loadConfig();
  if (!cfg.cerebrasApiKey) return undefined;
  return async (o: { model: string; system: string; user: string }) => {
    await new Promise((r) => setTimeout(r, 400));
    return chat({
      model: o.model,
      system: o.system,
      user: o.user,
      attempts: 5,
    });
  };
})();

export const app = new Hono();

app.get("/api/projects", async (c) => {
  const tools = buildTools(pool, { fixturesDir: FIXTURES });
  return c.json(
    await tools.find((t) => t.name === "list_projects")!.run({ query: "" }),
  );
});

app.get("/api/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "q is required" }, 400);
  const project = c.req.query("project") || undefined;
  return c.json(await search(pool, q, { project, llm, fixturesDir: FIXTURES }));
});

app.get("/api/ask", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "q is required" }, 400);
  if (!llm)
    return c.json({ error: "CEREBRAS_API_KEY is not set; ask needs it" }, 503);
  const project = c.req.query("project") || undefined;
  return streamSSE(c, async (stream) => {
    try {
      await askStream(
        pool,
        q,
        { project, fixturesDir: FIXTURES, llm },
        (e) =>
          void stream.writeSSE({ event: e.stage, data: JSON.stringify(e) }),
      );
      await stream.writeSSE({ event: "done", data: "{}" });
    } catch (err) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: String(err) }),
      });
    }
  });
});

app.use("/*", serveStatic({ root: "./packages/web/dist" }));

export async function closePool(): Promise<void> {
  await pool.end();
}

if (
  process.argv[1]?.endsWith("api.ts") ||
  process.argv[1]?.endsWith("api.js")
) {
  serve({ fetch: app.fetch, port: 8787 });
  console.log("kb web on http://localhost:8787");
}
