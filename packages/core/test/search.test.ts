import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { getPool } from "../src/schema/db.js";
import { search } from "../src/retrieval/search.js";
import { ensureCorpus } from "./helpers.js";

const ROOT = join(import.meta.dirname, "../../..");
const pool = getPool();
beforeAll(() => ensureCorpus(pool), 600_000);
afterAll(async () => {
  await pool.end();
});

describe("search", () => {
  it("answers the flagship cross-source question without any LLM", async () => {
    const { evidence, trace } = await search(
      pool,
      "Why does checkpoint restore stall after manifest load?",
      { project: "helios-eng", fixturesDir: join(ROOT, "fixtures") },
    );
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.length).toBeLessThanOrEqual(10);
    const ids = evidence.map((e) => e.sourceId);
    expect(ids.some((id) => id.startsWith("HEL-482"))).toBe(true);
    expect(ids.some((id) => id.startsWith("HEL-001"))).toBe(true);
    expect(trace.rerank.applied).toBe(false);
    expect(trace.lists.map((l) => l.name)).toEqual(
      expect.arrayContaining([
        "fts",
        "vector",
        "rare",
        "recency",
        "confluence-vector",
        "github-vector",
        "jira-vector",
      ]),
    );
    expect(trace.fused[0].contributions.length).toBeGreaterThan(0);
  });

  it("scopes to the content project", async () => {
    const { evidence } = await search(
      pool,
      "what does the launch draft say about pricing?",
      { project: "content" },
    );
    for (const e of evidence) expect(e.source).toBe("bucket");
  });

  it("applies rerank scores when an llm is provided", async () => {
    const llm = async () =>
      JSON.stringify(
        Array.from({ length: 20 }, (_, i) => ({
          i,
          score: 20 - i > 10 ? 10 : 1,
        })),
      );
    const { trace } = await search(pool, "checkpoint restore stalls", {
      llm,
      rerankModel: "m",
    });
    expect(trace.rerank.applied).toBe(true);
    expect(trace.rerank.scores.length).toBeGreaterThan(0);
  });
});
