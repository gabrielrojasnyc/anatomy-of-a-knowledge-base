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
  const server = await createKbServer(pool, join(ROOT, "fixtures"));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
}, 600_000);
afterAll(async () => {
  await client.close();
  await pool.end();
});

describe("kb mcp server", () => {
  it("lists exactly the eight tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_document",
      "list_projects",
      "search",
      "search_code",
      "search_confluence",
      "search_jira",
      "status",
      "who_knows",
    ]);
  });

  it("status answers the readiness question over the wire", async () => {
    const res = await client.callTool({ name: "status", arguments: {} });
    expect(res.isError).toBeFalsy();
    const rows = JSON.parse((res.content as { text: string }[])[0].text) as {
      title: string;
    }[];
    expect(rows.map((r) => r.title)).toContain("jira");
  });

  it("list_projects accepts the natural zero-argument call", async () => {
    const res = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    expect(res.isError).toBeFalsy();
    const rows = JSON.parse((res.content as { text: string }[])[0].text) as {
      sourceId: string;
    }[];
    expect(rows.map((r) => r.sourceId).sort()).toEqual([
      "content",
      "helios-eng",
    ]);
  });

  it("advertises the live project names on search's project parameter", async () => {
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "search")!;
    const project = (
      search.inputSchema as {
        properties: Record<string, { description?: string }>;
      }
    ).properties.project;
    expect(project.description).toContain("helios-eng");
    expect(project.description).toContain("content");
  });

  it("get_document dereferences a citation over the wire", async () => {
    const res = await client.callTool({
      name: "get_document",
      arguments: { uri: "jira://HEL-482" },
    });
    expect(res.isError).toBeFalsy();
    const rows = JSON.parse((res.content as { text: string }[])[0].text) as {
      sourceId: string;
      content: string;
    }[];
    expect(rows[0].sourceId).toBe("HEL-482");
    expect(rows[0].content).toContain("manifest");
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
