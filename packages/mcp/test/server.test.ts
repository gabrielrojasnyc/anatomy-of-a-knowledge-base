import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getPool } from "@kb/core";
import { createKbServer } from "../src/server.js";
import { ensureCorpus } from "../../core/test/helpers.js";

const ROOT = join(import.meta.dirname, "../../..");
const pool = getPool();
const client = new Client({ name: "test-client", version: "1.0.0" });

beforeAll(async () => {
  await ensureCorpus(pool);
  const server = createKbServer(pool, join(ROOT, "fixtures"));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
}, 600_000);
afterAll(async () => {
  await client.close();
  await pool.end();
});

describe("kb mcp server", () => {
  it("lists exactly the six tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "list_projects",
      "search",
      "search_code",
      "search_confluence",
      "search_jira",
      "who_knows",
    ]);
  });

  it("search_code returns evidence rows as JSON text", async () => {
    const res = await client.callTool({
      name: "search_code",
      arguments: { query: "HELIOS_PREFETCH_DEPTH" },
    });
    const content = res.content as { type: string; text: string }[];
    expect(content[0].type).toBe("text");
    const rows = JSON.parse(content[0].text) as { sourceId: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].sourceId).toMatch(/^src\//);
  });

  it("who_knows works over the wire", async () => {
    const res = await client.callTool({
      name: "who_knows",
      arguments: { query: "shard cache" },
    });
    const rows = JSON.parse((res.content as { text: string }[])[0].text) as {
      sourceId: string;
    }[];
    expect(rows.map((r) => r.sourceId)).toContain("Priya Natarajan");
  });
});
