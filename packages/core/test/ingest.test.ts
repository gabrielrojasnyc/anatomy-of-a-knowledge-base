import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { getPool } from "../src/schema/db.js";
import { migrate } from "../src/schema/migrate.js";
import { runIngest } from "../src/ingest/run.js";

const ROOT = join(import.meta.dirname, "../../..");
const pool = getPool();
const mockLlm = async ({ system }: { system: string }) =>
  system.includes("issue tracker")
    ? JSON.stringify({
        question: "q",
        summary: "s",
        resolution: "r",
        systems: [],
        code_refs: [],
      })
    : JSON.stringify({ summary: "distilled summary", key_facts: ["fact"] });

beforeAll(async () => {
  await migrate(pool);
  await pool.query(
    `TRUNCATE embeddings, token_idf, project_sources, projects, sources`,
  );
}, 30_000);
afterAll(async () => {
  await pool.end();
});

describe("runIngest", () => {
  it("ingests the full fixture corpus", { timeout: 600_000 }, async () => {
    const s = await runIngest(pool, {
      fixturesDir: join(ROOT, "fixtures"),
      llm: mockLlm,
      distillModel: "test",
      log: () => {},
    });
    for (const src of ["confluence", "jira", "github", "bucket"]) {
      expect(s.perSource[src].ingested, src).toBeGreaterThan(0);
      expect(s.perSource[src].failed, src).toBe(0);
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM embeddings WHERE embedding IS NOT NULL`,
    );
    expect(rows[0].n).toBeGreaterThan(100);
    const idf = await pool.query(`SELECT count(*)::int AS n FROM token_idf`);
    expect(idf.rows[0].n).toBeGreaterThan(200);
    const projects = await pool.query(
      `SELECT count(*)::int AS n FROM projects`,
    );
    expect(projects.rows[0].n).toBe(2);
  });

  it("skips everything on a second run", { timeout: 600_000 }, async () => {
    const s = await runIngest(pool, {
      fixturesDir: join(ROOT, "fixtures"),
      llm: mockLlm,
      distillModel: "test",
      log: () => {},
    });
    for (const src of Object.keys(s.perSource)) {
      expect(s.perSource[src].ingested, src).toBe(0);
      expect(s.perSource[src].skipped, src).toBeGreaterThan(0);
    }
  });
});
