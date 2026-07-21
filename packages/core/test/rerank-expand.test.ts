import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { getPool } from "../src/schema/db.js";
import { rerank } from "../src/retrieval/rerank.js";
import { expandDoc } from "../src/retrieval/expand.js";
import type { FusedDoc } from "../src/retrieval/rrf.js";
import type { RetrievedDoc } from "../src/retrieval/types.js";
import { ensureCorpus } from "./helpers.js";

const ROOT = join(import.meta.dirname, "../../..");
const pool = getPool();
beforeAll(() => ensureCorpus(pool), 600_000);
afterAll(async () => {
  await pool.end();
});

const fused = (
  source: string,
  sourceId: string,
  content: string,
): FusedDoc => ({
  doc: {
    id: 0,
    source,
    sourceId,
    kind: "k",
    title: sourceId,
    content,
    metadata: {},
    authoredAt: null,
    score: 1,
  },
  score: 0.03,
  contributions: [],
});

describe("rerank", () => {
  it("maps scores back by source:sourceId from one batched call", async () => {
    const llm = async () =>
      JSON.stringify([
        { i: 0, score: 9 },
        { i: 1, score: 2 },
      ]);
    const out = await rerank(
      "q",
      [fused("a", "D1", "x"), fused("a", "D2", "y")],
      { llm, model: "m" },
    );
    expect(out).not.toBeNull();
    expect(out!.get("a:D1")).toBe(9);
    expect(out!.get("a:D2")).toBe(2);
  });

  it("returns null when the LLM fails so fused order stands", async () => {
    const llm = async () => {
      throw new Error("down");
    };
    expect(
      await rerank("q", [fused("a", "D1", "x")], { llm, model: "m" }),
    ).toBeNull();
  });

  it("clamps scores and ignores out-of-range indexes", async () => {
    const llm = async () =>
      JSON.stringify([
        { i: 0, score: 100 },
        { i: 7, score: 5 },
        { i: 1, score: Number.NaN },
      ]);
    const out = await rerank(
      "q",
      [fused("a", "D1", "x"), fused("a", "D2", "y")],
      { llm, model: "m" },
    );
    expect(out).not.toBeNull();
    expect(out!.get("a:D1")).toBe(10);
    expect(out!.has("a:D2")).toBe(false);
    expect(out!.size).toBe(1);
  });
});

describe("expandDoc", () => {
  it("pulls neighbor sections for a confluence section", async () => {
    const { rows } = await pool.query(
      `SELECT id, source, source_id, kind, title, content, metadata, authored_at
         FROM embeddings WHERE source='confluence' AND kind='page_section'
          AND source_id LIKE 'HEL-001#%' ORDER BY source_id LIMIT 1`,
    );
    expect(rows.length).toBe(1);
    const doc: RetrievedDoc = {
      id: rows[0].id,
      source: rows[0].source,
      sourceId: rows[0].source_id,
      kind: rows[0].kind,
      title: rows[0].title,
      content: rows[0].content,
      metadata: rows[0].metadata,
      authoredAt: null,
      score: 1,
    };
    const expanded = await expandDoc(pool, doc);
    expect(expanded.length).toBeGreaterThan(doc.content.length);
    expect(expanded).toContain(doc.content);
  });

  it("attaches surrounding code lines for a code chunk", async () => {
    const { rows } = await pool.query(
      `SELECT id, source, source_id, kind, title, content, metadata, authored_at
         FROM embeddings WHERE source='github' LIMIT 1`,
    );
    const doc: RetrievedDoc = {
      id: rows[0].id,
      source: rows[0].source,
      sourceId: rows[0].source_id,
      kind: rows[0].kind,
      title: rows[0].title,
      content: rows[0].content,
      metadata: rows[0].metadata,
      authoredAt: null,
      score: 1,
    };
    const expanded = await expandDoc(pool, doc, {
      fixturesDir: join(ROOT, "fixtures"),
    });
    expect(expanded.length).toBeGreaterThanOrEqual(doc.content.length);
  });
});
