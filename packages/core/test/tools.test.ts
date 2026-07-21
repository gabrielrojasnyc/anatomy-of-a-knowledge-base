import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { getPool } from "../src/schema/db.js";
import { buildTools } from "../src/answer/tools.js";
import { ensureCorpus } from "./helpers.js";

const ROOT = join(import.meta.dirname, "../../..");
const pool = getPool();
const tools = buildTools(pool, { fixturesDir: join(ROOT, "fixtures") });
const get = (name: string) => tools.find((t) => t.name === name)!;
beforeAll(() => ensureCorpus(pool), 600_000);
afterAll(async () => {
  await pool.end();
});

describe("buildTools", () => {
  it("exposes exactly the six tools", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      "list_projects",
      "search",
      "search_code",
      "search_confluence",
      "search_jira",
      "who_knows",
    ]);
    for (const t of tools) expect(t.description.length).toBeGreaterThan(10);
  });

  it("search_code finds the prefetch flag without any LLM", async () => {
    const rows = await get("search_code").run({
      query: "HELIOS_PREFETCH_DEPTH",
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].content).toContain("HELIOS_PREFETCH_DEPTH");
    expect(rows[0].sourceId).toMatch(/^src\/.+:\d+$/);
  });

  it("who_knows surfaces Priya for the shard cache", async () => {
    const rows = await get("who_knows").run({ query: "shard cache" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.slice(0, 3).map((r) => r.sourceId)).toContain(
      "Priya Natarajan",
    );
  });

  it("search_jira only returns jira evidence", async () => {
    const rows = await get("search_jira").run({ query: "manifest timeout" });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.source).toBe("jira");
  });

  it("list_projects names both projects", async () => {
    const rows = await get("list_projects").run({ query: "" });
    expect(rows.map((r) => r.sourceId).sort()).toEqual([
      "content",
      "helios-eng",
    ]);
  });

  it("search_code treats metacharacters literally unless re: prefix is used", async () => {
    const literal = await get("search_code").run({
      query: "config.prefetchDepth",
    });
    expect(literal.length).toBeGreaterThan(0);
    const regex = await get("search_code").run({
      query: "re:prefetch(Depth)?",
    });
    expect(regex.length).toBeGreaterThan(0);
  });
});
