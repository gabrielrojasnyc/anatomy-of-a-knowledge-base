import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { getPool } from "../src/schema/db.js";
import { buildTools } from "../src/answer/tools.js";
import { codeLinks } from "../src/retrieval/links.js";
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
  it("exposes exactly the eight tools", () => {
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
    for (const t of tools) expect(t.description.length).toBeGreaterThan(10);
  });

  it("every advertised parameter is one the tool actually reads", () => {
    // list_projects takes nothing; only search takes project. The schema an
    // agent sees must match what the code does, so this is a contract test.
    const params = Object.fromEntries(
      tools.map((t) => [t.name, t.params.map((p) => p.name).sort()]),
    );
    expect(params.list_projects).toEqual([]);
    expect(params.status).toEqual([]);
    expect(params.search).toEqual(["limit", "project", "query"]);
    expect(params.search_confluence).toEqual(["limit", "query"]);
    expect(params.search_jira).toEqual(["limit", "query"]);
    expect(params.search_code).toEqual(["limit", "query"]);
    expect(params.who_knows).toEqual(["query"]);
    expect(params.get_document).toEqual(["uri"]);
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

  it("search_jira only returns jira evidence, with provenance", async () => {
    const rows = await get("search_jira").run({ query: "manifest timeout" });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.source).toBe("jira");
      expect(r.scoreKind).toBe("fused");
      expect(r.retrieverAgreement).toBeGreaterThanOrEqual(1);
      expect(r.authors?.length).toBeGreaterThan(0);
    }
  });

  it("source tools honor limit", async () => {
    const rows = await get("search_jira").run({
      query: "checkpoint",
      limit: 2,
    });
    expect(rows.length).toBeLessThanOrEqual(2);
  });

  it("search_code appends a meta row when matches exceed limit", async () => {
    const rows = await get("search_code").run({ query: "re:.", limit: 3 });
    expect(rows.length).toBe(4);
    const meta = rows[rows.length - 1];
    expect(meta.source).toBe("meta");
    expect(meta.content).toMatch(/matched \d+ lines; showing the first 3/);
  });

  it("list_projects names both projects with zero arguments", async () => {
    const rows = await get("list_projects").run({});
    expect(rows.map((r) => r.sourceId).sort()).toEqual([
      "content",
      "helios-eng",
    ]);
  });

  it("get_document returns the whole jira thread, every comment", async () => {
    const rows = await get("get_document").run({ uri: "jira://HEL-482" });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("HEL-482");
    expect(rows[0].authors!.length).toBeGreaterThan(1);
    // The full thread carries more than expandDoc's longest+last pick: every
    // [author, date] line appears once per description or comment.
    expect(rows[0].content.match(/^\[/gm)!.length).toBeGreaterThanOrEqual(3);
  });

  it("get_document assembles every section of a confluence page", async () => {
    const rows = await get("get_document").run({
      uri: "confluence://HELIOS/HEL-008",
    });
    expect(rows).toHaveLength(1);
    const { rows: db } = await pool.query(
      `SELECT count(*)::int AS n FROM embeddings
        WHERE source = 'confluence' AND source_id LIKE 'HEL-008#%'
          AND raw->>'heading' IS NOT NULL`,
    );
    expect(rows[0].content.match(/^## /gm)!.length).toBe(db[0].n);
  });

  it("get_document reads a whole source file", async () => {
    const rows = await get("get_document").run({
      uri: "github://helios/src/config/env.ts",
    });
    expect(rows[0].content).toContain("HELIOS_PREFETCH_DEPTH");
  });

  it("get_document resolves a bare id when unambiguous", async () => {
    const rows = await get("get_document").run({ uri: "HEL-482" });
    expect(rows[0].source).toBe("jira");
  });

  it("codeLinks keeps only refs that name a real file", () => {
    const links = codeLinks(
      {
        code_refs: [
          "src/checkpoint/loader.ts",
          "HELIOS_PREFETCH_DEPTH",
          "src/serving",
          "../../../etc/passwd",
        ],
      },
      join(ROOT, "fixtures"),
    );
    expect(links).toEqual(["github://helios/src/checkpoint/loader.ts"]);
    expect(codeLinks({ code_refs: ["src/checkpoint/loader.ts"] })).toEqual([]);
  });

  it("status reports every ingested source with counts", async () => {
    const rows = await get("status").run({});
    expect(rows.map((r) => r.title).sort()).toEqual([
      "bucket",
      "confluence",
      "github",
      "jira",
    ]);
    for (const r of rows) {
      expect(r.source).toBe("meta");
      expect(r.content).toMatch(/\d+ docs, \d+% distilled/);
    }
  });

  it("get_document explains itself on an unknown uri", async () => {
    await expect(
      get("get_document").run({ uri: "wiki://nope" }),
    ).rejects.toThrow(/jira:\/\//);
    await expect(get("get_document").run({ uri: "HEL-9999" })).rejects.toThrow(
      /no document found/,
    );
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
