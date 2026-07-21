# Plan 2 of 3: Retrieval and Answers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The full query side: five retrievers fused by RRF, LLM rerank, context expansion, planner/executor/synthesis, `kb search --explain`, `kb ask --trace`, `kb who-knows`, and a golden-question eval.

**Architecture:** `packages/core/src/retrieval/` holds the LLM-free retrieval pipeline (retrievers, fusion, expansion) plus one LLM touchpoint (rerank). `packages/core/src/answer/` holds tools, planner, executor, synthesis. The CLI renders traces; the eval grades retrieval against `eval/golden.json`.

**Tech Stack:** unchanged from Plan 1 (TypeScript ESM, pg, transformers.js embeddings, Cerebras via plain fetch, vitest).

## Global Constraints

- No em dashes and no double dashes in any prose, docs, comments, or commit messages. CLI flags in code are fine.
- ESM everywhere; relative imports use `.js` extensions.
- Tests run against `kb_test` (vitest sets DATABASE_URL; globalSetup creates the DB). The live `kb` store must never be touched by tests.
- The store schema and 237-row live corpus are fixed by Plan 1; nothing in this plan alters the `embeddings` table or ingest behavior except one line noted in Task 2.
- Retrieval through fusion is LLM-free and must work with no API key. Only rerank, planner, and synthesis call Cerebras, and each failure degrades: rerank keeps fused order, planner falls back to plain `search`, synthesis errors surface as CerebrasError.
- RRF: `score(d) = sum over lists of weight / (60 + rank)`, K = 60, default weight 1.0, dedupe to one representative per parent document, max 3 results per parent.
- Commit after every task. Commit messages explain why.

---

### Task 1: Retrieval types, FTS and vector retrievers

**Files:**
- Create: `packages/core/src/retrieval/types.ts`, `packages/core/src/retrieval/retrievers.ts`, `packages/core/test/helpers.ts`
- Test: `packages/core/test/retrievers.test.ts`
- Modify: `packages/core/src/index.ts` (append `export * from "./retrieval/types.js"; export { ftsRetriever, vectorRetriever, projectSources } from "./retrieval/retrievers.js";`)

**Interfaces:**
- Consumes: `getPool`, `embedQuery` from Plan 1.
- Produces:
  - `RetrievedDoc { id: number; source: string; sourceId: string; kind: string; title: string | null; content: string; metadata: Record<string, unknown>; authoredAt: Date | null; score: number }`
  - `RankedList { name: string; docs: RetrievedDoc[] }`
  - `EvidenceRow { content: string; source: string; sourceId: string; title: string | null; url: string; score: number; recency: string | null; tool: string }`
  - `ftsRetriever(pool, query: string, opts?: { sources?: string[]; limit?: number }): Promise<RankedList>`
  - `vectorRetriever(pool, qvec: number[], opts?: { sources?: string[]; limit?: number; name?: string }): Promise<RankedList>`
  - `projectSources(pool, project: string): Promise<string[]>`
- Corpus seeding: every retrieval-dependent test file calls a shared `ensureCorpus(pool)` helper in its `beforeAll`. The helper migrates, then checks whether `kb_test` already holds a raw-text corpus (at least 200 rows AND no mock marker; `ingest.test.ts`'s mock distillation writes content containing the literal string "distilled summary"). If the corpus is missing or mock-polluted, it truncates and re-ingests with `llm: undefined` so the fixture prose itself carries the search signal. This makes every test file order-independent and safe on a fresh database.

- [ ] **Step 1: Write the helper and the failing test**

`packages/core/test/helpers.ts`:
```ts
import { join } from "node:path";
import type pg from "pg";
import { migrate } from "../src/schema/migrate.js";
import { runIngest } from "../src/ingest/run.js";

const ROOT = join(import.meta.dirname, "../../..");

export async function ensureCorpus(pool: pg.Pool): Promise<void> {
  await migrate(pool);
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM embeddings) AS n,
            EXISTS(SELECT 1 FROM embeddings WHERE content LIKE '%distilled summary%') AS mock`);
  if (rows[0].n >= 200 && !rows[0].mock) return;
  await pool.query(`TRUNCATE embeddings, token_idf, project_sources, projects, sources`);
  await runIngest(pool, {
    fixturesDir: join(ROOT, "fixtures"), distillModel: "none", log: () => {},
  });
}
```

`packages/core/test/retrievers.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../src/schema/db.js";
import { embedQuery } from "../src/models/embeddings.js";
import { ftsRetriever, vectorRetriever, projectSources } from "../src/retrieval/retrievers.js";
import { ensureCorpus } from "./helpers.js";

const pool = getPool();

beforeAll(() => ensureCorpus(pool), 600_000);
afterAll(async () => { await pool.end(); });

describe("ftsRetriever", () => {
  it("finds exact tokens like error strings", async () => {
    const list = await ftsRetriever(pool, "ERR_MANIFEST_TIMEOUT");
    expect(list.name).toBe("fts");
    expect(list.docs.length).toBeGreaterThan(0);
    expect(list.docs[0].content).toContain("ERR_MANIFEST_TIMEOUT");
    expect(list.docs[0].score).toBeGreaterThan(0);
  });

  it("respects a source filter", async () => {
    const list = await ftsRetriever(pool, "checkpoint restore", { sources: ["confluence"] });
    for (const d of list.docs) expect(d.source).toBe("confluence");
  });
});

describe("vectorRetriever", () => {
  it("catches paraphrase with no shared vocabulary", async () => {
    const qvec = await embedQuery("the model server refuses to boot after I changed its settings");
    const list = await vectorRetriever(pool, qvec, { limit: 20 });
    expect(list.name).toBe("vector");
    expect(list.docs.some(d => d.sourceId.startsWith("HEL-007"))).toBe(true);
  });

  it("orders by descending similarity", async () => {
    const qvec = await embedQuery("checkpoint restore stalls");
    const { docs } = await vectorRetriever(pool, qvec, { limit: 10 });
    for (let i = 1; i < docs.length; i++)
      expect(docs[i - 1].score).toBeGreaterThanOrEqual(docs[i].score);
  });
});

describe("projectSources", () => {
  it("maps projects to their sources", async () => {
    expect((await projectSources(pool, "helios-eng")).sort())
      .toEqual(["confluence", "github", "jira"]);
    expect(await projectSources(pool, "content")).toEqual(["bucket"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/retrievers.test.ts`
Expected: FAIL, module not found. (The beforeAll ingest takes a few minutes on first run.)

- [ ] **Step 3: Implement**

`packages/core/src/retrieval/types.ts`:
```ts
export interface RetrievedDoc {
  id: number;
  source: string;
  sourceId: string;
  kind: string;
  title: string | null;
  content: string;
  metadata: Record<string, unknown>;
  authoredAt: Date | null;
  score: number;
}

export interface RankedList {
  name: string;
  docs: RetrievedDoc[];
}

export interface EvidenceRow {
  content: string;
  source: string;
  sourceId: string;
  title: string | null;
  url: string;
  score: number;
  recency: string | null;
  tool: string;
}
```

`packages/core/src/retrieval/retrievers.ts`:
```ts
import type pg from "pg";
import type { RankedList, RetrievedDoc } from "./types.js";

const COLS = `id, source, source_id, kind, title, content, metadata, authored_at`;

function toDoc(r: Record<string, unknown>, score: number): RetrievedDoc {
  return {
    id: Number(r.id),
    source: r.source as string,
    sourceId: r.source_id as string,
    kind: r.kind as string,
    title: (r.title as string) ?? null,
    content: r.content as string,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    authoredAt: r.authored_at ? new Date(r.authored_at as string) : null,
    score,
  };
}

export async function ftsRetriever(
  pool: pg.Pool, query: string,
  opts: { sources?: string[]; limit?: number } = {}
): Promise<RankedList> {
  const { rows } = await pool.query(
    `SELECT ${COLS}, ts_rank(tsv, q) AS score
       FROM embeddings, websearch_to_tsquery('english', $1) q
      WHERE tsv @@ q AND ($2::text[] IS NULL OR source = ANY($2))
      ORDER BY score DESC LIMIT $3`,
    [query, opts.sources ?? null, opts.limit ?? 50]
  );
  return { name: "fts", docs: rows.map(r => toDoc(r, Number(r.score))) };
}

export async function vectorRetriever(
  pool: pg.Pool, qvec: number[],
  opts: { sources?: string[]; limit?: number; name?: string } = {}
): Promise<RankedList> {
  const lit = `[${qvec.join(",")}]`;
  const { rows } = await pool.query(
    `SELECT ${COLS}, 1 - (embedding <=> $1::vector) AS score
       FROM embeddings
      WHERE embedding IS NOT NULL AND ($2::text[] IS NULL OR source = ANY($2))
      ORDER BY embedding <=> $1::vector LIMIT $3`,
    [lit, opts.sources ?? null, opts.limit ?? 50]
  );
  return { name: opts.name ?? "vector", docs: rows.map(r => toDoc(r, Number(r.score))) };
}

export async function projectSources(pool: pg.Pool, project: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT source FROM project_sources WHERE project = $1`, [project]);
  return rows.map(r => r.source as string);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/retrievers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add the two workhorse retrievers: exact tokens and paraphrase"
```

---

### Task 2: Rare-token and recency retrievers

**Files:**
- Create: `packages/core/src/retrieval/signals.ts`
- Test: `packages/core/test/signals.test.ts`
- Modify: `packages/core/src/index.ts` (append `export { rareTokenRetriever, recencyRetriever, HALF_LIFE_DAYS } from "./retrieval/signals.js";`), `packages/core/src/ingest/connectors/jira.ts` (one line, Step 3)

**Interfaces:**
- Consumes: `tokenize` (Plan 1), `vectorRetriever`, types from Task 1.
- Produces:
  - `rareTokenRetriever(pool, query: string, opts?: { sources?: string[]; limit?: number; minIdf?: number }): Promise<RankedList>` (name `"rare"`): looks up query tokens in `token_idf`, keeps up to 5 with idf >= minIdf (default 2.0), fetches candidate rows containing any of them with ILIKE, scores each row in JS by summing the idf of the rare tokens present, ranks descending. Empty list when no query token is rare.
  - `recencyRetriever(pool, qvec, opts?: { sources?: string[]; limit?: number }): Promise<RankedList>` (name `"recency"`): takes the vector top 100 and rescales each score by `Math.exp(-ageDays * Math.LN2 / halfLife)` using per-source half-lives, re-sorts, trims to limit.
  - `HALF_LIFE_DAYS: Record<string, number>` = `{ jira: 90, confluence: 180, bucket: 365, github: 3650 }` with 365 as fallback.

- [ ] **Step 1: Write the failing test**

`packages/core/test/signals.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../src/schema/db.js";
import { embedQuery } from "../src/models/embeddings.js";
import { rareTokenRetriever, recencyRetriever } from "../src/retrieval/signals.js";
import { ensureCorpus } from "./helpers.js";

const pool = getPool();
beforeAll(() => ensureCorpus(pool), 600_000);
afterAll(async () => { await pool.end(); });

describe("rareTokenRetriever", () => {
  it("ranks rows containing a rare flag above everything else", async () => {
    const list = await rareTokenRetriever(pool, "what is HELIOS_PREFETCH_DEPTH");
    expect(list.name).toBe("rare");
    expect(list.docs.length).toBeGreaterThan(0);
    expect(list.docs[0].content.toLowerCase()).toContain("helios_prefetch_depth");
  });

  it("returns an empty list for filler-only queries", async () => {
    const list = await rareTokenRetriever(pool, "sounds good thanks will try that");
    expect(list.docs).toEqual([]);
  });
});

describe("recencyRetriever", () => {
  it("prefers the newer of two deploy pages", async () => {
    const qvec = await embedQuery("what is the current deploy process for Helios?");
    const list = await recencyRetriever(pool, qvec, { sources: ["confluence"] });
    const rank21 = list.docs.findIndex(d => d.sourceId.startsWith("HEL-021"));
    const rank20 = list.docs.findIndex(d => d.sourceId.startsWith("HEL-020"));
    expect(rank21).toBeGreaterThanOrEqual(0);
    if (rank20 >= 0) expect(rank21).toBeLessThan(rank20);
  });
});
```

Note: `ensureCorpus` makes this file order-independent; it only re-ingests when the corpus is missing or mock-polluted.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/signals.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement, plus the burst timestamp fix**

`packages/core/src/retrieval/signals.ts`:
```ts
import type pg from "pg";
import { tokenize } from "../ingest/idf.js";
import { vectorRetriever } from "./retrievers.js";
import type { RankedList, RetrievedDoc } from "./types.js";

export const HALF_LIFE_DAYS: Record<string, number> = {
  jira: 90, confluence: 180, bucket: 365, github: 3650,
};

export async function rareTokenRetriever(
  pool: pg.Pool, query: string,
  opts: { sources?: string[]; limit?: number; minIdf?: number } = {}
): Promise<RankedList> {
  const minIdf = opts.minIdf ?? 2.0;
  const tokens = [...new Set(tokenize(query))];
  const { rows: idfRows } = await pool.query(
    `SELECT token, idf FROM token_idf WHERE token = ANY($1) AND idf >= $2
      ORDER BY idf DESC LIMIT 5`, [tokens, minIdf]);
  if (idfRows.length === 0) return { name: "rare", docs: [] };
  const rare = new Map(idfRows.map(r => [r.token as string, Number(r.idf)]));
  const patterns = [...rare.keys()].map(t => `%${t}%`);
  const { rows } = await pool.query(
    `SELECT id, source, source_id, kind, title, content, metadata, authored_at
       FROM embeddings
      WHERE content ILIKE ANY($1) AND ($2::text[] IS NULL OR source = ANY($2))
      LIMIT 200`,
    [patterns, opts.sources ?? null]);
  const docs: RetrievedDoc[] = rows.map(r => {
    const present = new Set(tokenize(r.content as string));
    let score = 0;
    for (const [tok, idf] of rare) if (present.has(tok)) score += idf;
    return {
      id: Number(r.id), source: r.source, sourceId: r.source_id, kind: r.kind,
      title: r.title ?? null, content: r.content,
      metadata: r.metadata ?? {}, authoredAt: r.authored_at ? new Date(r.authored_at) : null,
      score,
    };
  }).filter(d => d.score > 0);
  docs.sort((a, b) => b.score - a.score);
  return { name: "rare", docs: docs.slice(0, opts.limit ?? 50) };
}

export async function recencyRetriever(
  pool: pg.Pool, qvec: number[],
  opts: { sources?: string[]; limit?: number } = {}
): Promise<RankedList> {
  const base = await vectorRetriever(pool, qvec, { sources: opts.sources, limit: 100 });
  const now = Date.now();
  const docs = base.docs.map(d => {
    const half = HALF_LIFE_DAYS[d.source] ?? 365;
    const ageDays = d.authoredAt ? Math.max(0, (now - d.authoredAt.getTime()) / 86_400_000) : half;
    return { ...d, score: d.score * Math.exp(-ageDays * Math.LN2 / half) };
  });
  docs.sort((a, b) => b.score - a.score);
  return { name: "recency", docs: docs.slice(0, opts.limit ?? 50) };
}
```

The burst timestamp fix (deferred from Plan 1, needed by recency): in `packages/core/src/ingest/connectors/jira.ts`, the `comment_burst` doc currently inherits the issue's `authoredAt` via `...base`. Change that push to set `authoredAt: new Date(b.at)` after the spread so each burst carries its own first-comment timestamp. Existing store rows keep the old value until content changes; the eval does not depend on burst recency, and `docs/08-scaling.md` will note the nuance.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/signals.test.ts packages/core/test/connectors-code-jira.test.ts`
Expected: PASS (3 + 4 tests; the jira connector tests confirm the one-line change broke nothing).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Score rarity and freshness separately so filler never outranks signal"
```

---

### Task 3: RRF fusion, dedupe, per-parent caps

**Files:**
- Create: `packages/core/src/retrieval/rrf.ts`
- Test: `packages/core/test/rrf.test.ts`
- Modify: `packages/core/src/index.ts` (append `export { fuse, parentKey } from "./retrieval/rrf.js";`)

**Interfaces:**
- Consumes: `RankedList`, `RetrievedDoc` from Task 1.
- Produces:
  - `parentKey(doc: Pick<RetrievedDoc, "source" | "sourceId">): string` returning `` `${source}:${sourceId.split("#")[0]}` ``
  - `FusedDoc { doc: RetrievedDoc; score: number; contributions: { list: string; rank: number; contribution: number }[] }`
  - `fuse(lists: RankedList[], opts?: { k?: number; weights?: Record<string, number>; maxPerParent?: number; limit?: number }): FusedDoc[]` implementing RRF (K=60), keyed by `source:sourceId` for scoring, then deduped so each parent keeps only its best-scoring representative and at most `maxPerParent` (default 3) rows survive per parent, trimmed to `limit` (default 20).

This is pure, dependency-free code. The test pins a hand-computed table.

- [ ] **Step 1: Write the failing test**

`packages/core/test/rrf.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { fuse, parentKey } from "../src/retrieval/rrf.js";
import type { RankedList, RetrievedDoc } from "../src/retrieval/types.js";

const doc = (source: string, sourceId: string): RetrievedDoc => ({
  id: 0, source, sourceId, kind: "k", title: null, content: sourceId,
  metadata: {}, authoredAt: null, score: 1,
});
const list = (name: string, ids: [string, string][]): RankedList =>
  ({ name, docs: ids.map(([s, i]) => doc(s, i)) });

describe("parentKey", () => {
  it("strips the fragment", () => {
    expect(parentKey(doc("confluence", "HEL-001#2"))).toBe("confluence:HEL-001");
    expect(parentKey(doc("jira", "HEL-482"))).toBe("jira:HEL-482");
  });
});

describe("fuse", () => {
  it("matches the hand-computed RRF table", () => {
    const lists = [
      list("a", [["x", "D1"], ["x", "D2"], ["x", "D3"]]),
      list("b", [["x", "D2"], ["x", "D1"]]),
    ];
    const out = fuse(lists);
    // D1: 1/61 + 1/62 = 0.0325222; D2: 1/62 + 1/61 = same; D3: 1/63.
    // Ties broken by first appearance; D1 leads list a.
    expect(out[0].doc.sourceId).toBe("D1");
    expect(out[0].score).toBeCloseTo(1 / 61 + 1 / 62, 6);
    expect(out[2].doc.sourceId).toBe("D3");
    expect(out[2].score).toBeCloseTo(1 / 63, 6);
    expect(out[0].contributions).toHaveLength(2);
    expect(out[0].contributions[0]).toEqual(
      { list: "a", rank: 1, contribution: 1 / 61 });
  });

  it("applies per-list weights", () => {
    const lists = [
      list("a", [["x", "D1"]]),
      list("b", [["x", "D2"]]),
    ];
    const out = fuse(lists, { weights: { b: 2 } });
    expect(out[0].doc.sourceId).toBe("D2");
    expect(out[0].score).toBeCloseTo(2 / 61, 6);
  });

  it("caps results per parent and keeps the best representative first", () => {
    const lists = [list("a", [
      ["c", "P#0"], ["c", "P#1"], ["c", "P#2"], ["c", "P#3"], ["c", "Q#0"],
    ])];
    const out = fuse(lists, { maxPerParent: 3 });
    const fromP = out.filter(f => parentKey(f.doc) === "c:P");
    expect(fromP).toHaveLength(3);
    expect(fromP[0].doc.sourceId).toBe("P#0");
    expect(out.some(f => f.doc.sourceId === "Q#0")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/rrf.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/core/src/retrieval/rrf.ts`:
```ts
import type { RankedList, RetrievedDoc } from "./types.js";

export function parentKey(doc: Pick<RetrievedDoc, "source" | "sourceId">): string {
  return `${doc.source}:${doc.sourceId.split("#")[0]}`;
}

export interface FusedDoc {
  doc: RetrievedDoc;
  score: number;
  contributions: { list: string; rank: number; contribution: number }[];
}

export function fuse(
  lists: RankedList[],
  opts: { k?: number; weights?: Record<string, number>; maxPerParent?: number; limit?: number } = {}
): FusedDoc[] {
  const k = opts.k ?? 60;
  const byId = new Map<string, FusedDoc>();
  for (const list of lists) {
    const weight = opts.weights?.[list.name] ?? 1.0;
    list.docs.forEach((doc, i) => {
      const rank = i + 1;
      const contribution = weight / (k + rank);
      const key = `${doc.source}:${doc.sourceId}`;
      const entry = byId.get(key) ?? { doc, score: 0, contributions: [] };
      entry.score += contribution;
      entry.contributions.push({ list: list.name, rank, contribution });
      byId.set(key, entry);
    });
  }
  const fused = [...byId.values()].sort((a, b) => b.score - a.score);
  const perParent = new Map<string, number>();
  const out: FusedDoc[] = [];
  for (const f of fused) {
    const parent = parentKey(f.doc);
    const seen = perParent.get(parent) ?? 0;
    if (seen >= (opts.maxPerParent ?? 3)) continue;
    perParent.set(parent, seen + 1);
    out.push(f);
    if (out.length >= (opts.limit ?? 20)) break;
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/rrf.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Fuse with RRF because consensus across scorers beats any single vote"
```

---

### Task 4: LLM rerank and context expansion

**Files:**
- Create: `packages/core/src/retrieval/rerank.ts`, `packages/core/src/retrieval/expand.ts`
- Test: `packages/core/test/rerank-expand.test.ts`
- Modify: `packages/core/src/index.ts` (append `export { rerank } from "./retrieval/rerank.js"; export { expandDoc } from "./retrieval/expand.js";`)

**Interfaces:**
- Consumes: `chatJSON` (Plan 1), `FusedDoc` (Task 3).
- Produces:
  - `rerank(query: string, candidates: FusedDoc[], opts: { llm: (o: { model: string; system: string; user: string }) => Promise<string>; model: string }): Promise<Map<string, number> | null>` returning `source:sourceId` to score 0..10 from ONE batched LLM call, or `null` on any failure (caller keeps fused order).
  - `expandDoc(pool, doc: RetrievedDoc, opts?: { fixturesDir?: string }): Promise<string>` returning the doc's content plus recovered context: neighbor sections for `page_section`/`doc_section`, the longest and the final comment for `issue_thread`, 10 surrounding lines from the fixture file for `code_chunk`, unchanged content otherwise. Expansion failures return the original content.

- [ ] **Step 1: Write the failing test**

`packages/core/test/rerank-expand.test.ts`:
```ts
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
afterAll(async () => { await pool.end(); });

const fused = (source: string, sourceId: string, content: string): FusedDoc => ({
  doc: { id: 0, source, sourceId, kind: "k", title: sourceId, content,
    metadata: {}, authoredAt: null, score: 1 },
  score: 0.03, contributions: [],
});

describe("rerank", () => {
  it("maps scores back by source:sourceId from one batched call", async () => {
    const llm = async () => JSON.stringify([{ i: 0, score: 9 }, { i: 1, score: 2 }]);
    const out = await rerank("q", [fused("a", "D1", "x"), fused("a", "D2", "y")],
      { llm, model: "m" });
    expect(out).not.toBeNull();
    expect(out!.get("a:D1")).toBe(9);
    expect(out!.get("a:D2")).toBe(2);
  });

  it("returns null when the LLM fails so fused order stands", async () => {
    const llm = async () => { throw new Error("down"); };
    expect(await rerank("q", [fused("a", "D1", "x")], { llm, model: "m" })).toBeNull();
  });
});

describe("expandDoc", () => {
  it("pulls neighbor sections for a confluence section", async () => {
    const { rows } = await pool.query(
      `SELECT id, source, source_id, kind, title, content, metadata, authored_at
         FROM embeddings WHERE source='confluence' AND kind='page_section'
          AND source_id LIKE 'HEL-001#%' ORDER BY source_id LIMIT 1`);
    expect(rows.length).toBe(1);
    const doc: RetrievedDoc = {
      id: rows[0].id, source: rows[0].source, sourceId: rows[0].source_id,
      kind: rows[0].kind, title: rows[0].title, content: rows[0].content,
      metadata: rows[0].metadata, authoredAt: null, score: 1,
    };
    const expanded = await expandDoc(pool, doc);
    expect(expanded.length).toBeGreaterThan(doc.content.length);
    expect(expanded).toContain(doc.content);
  });

  it("attaches surrounding code lines for a code chunk", async () => {
    const { rows } = await pool.query(
      `SELECT id, source, source_id, kind, title, content, metadata, authored_at
         FROM embeddings WHERE source='github' LIMIT 1`);
    const doc: RetrievedDoc = {
      id: rows[0].id, source: rows[0].source, sourceId: rows[0].source_id,
      kind: rows[0].kind, title: rows[0].title, content: rows[0].content,
      metadata: rows[0].metadata, authoredAt: null, score: 1,
    };
    const expanded = await expandDoc(pool, doc, { fixturesDir: join(ROOT, "fixtures") });
    expect(expanded.length).toBeGreaterThanOrEqual(doc.content.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/rerank-expand.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/core/src/retrieval/rerank.ts`:
```ts
import type { FusedDoc } from "./rrf.js";

const SYSTEM = `You score search results for relevance to a query.
Reply with ONLY a JSON array: [{"i": <candidate index>, "score": <0 to 10>}].
10 means the candidate directly answers the query; 0 means unrelated.
A candidate that shares words with the query but answers a different question scores low.`;

export async function rerank(
  query: string, candidates: FusedDoc[],
  opts: { llm: (o: { model: string; system: string; user: string }) => Promise<string>; model: string }
): Promise<Map<string, number> | null> {
  const numbered = candidates.map((c, i) =>
    `<candidate i="${i}" title="${(c.doc.title ?? "").slice(0, 80)}">\n` +
    `${c.doc.content.slice(0, 300)}\n</candidate>`).join("\n");
  try {
    const reply = await opts.llm({
      model: opts.model, system: SYSTEM,
      user: `<query>${query}</query>\n${numbered}`,
    });
    const parsed = JSON.parse(reply.replace(/```(?:json)?|```/g, "").trim()) as
      { i: number; score: number }[];
    const out = new Map<string, number>();
    for (const { i, score } of parsed) {
      const c = candidates[i];
      if (c && Number.isFinite(score)) out.set(`${c.doc.source}:${c.doc.sourceId}`, score);
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}
```

`packages/core/src/retrieval/expand.ts`:
```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import type { RetrievedDoc } from "./types.js";

async function neighborSections(pool: pg.Pool, doc: RetrievedDoc): Promise<string[]> {
  const [base, idxStr] = doc.sourceId.split("#");
  const idx = Number(idxStr);
  if (!Number.isFinite(idx)) return [];
  const ids = [`${base}#${idx - 1}`, `${base}#${idx + 1}`];
  const { rows } = await pool.query(
    `SELECT raw FROM embeddings WHERE source = $1 AND source_id = ANY($2) ORDER BY source_id`,
    [doc.source, ids]);
  return rows.map(r => {
    const raw = r.raw as { heading?: string | null; body?: string } | null;
    return [raw?.heading, raw?.body].filter(Boolean).join("\n");
  }).filter(s => s.length > 0);
}

export async function expandDoc(
  pool: pg.Pool, doc: RetrievedDoc, opts: { fixturesDir?: string } = {}
): Promise<string> {
  try {
    if (doc.kind === "page_section" || doc.kind === "doc_section") {
      const neighbors = await neighborSections(pool, doc);
      if (neighbors.length === 0) return doc.content;
      return `${doc.content}\n\n[surrounding context]\n${neighbors.join("\n\n")}`;
    }
    if (doc.kind === "issue_thread") {
      const { rows } = await pool.query(
        `SELECT raw FROM embeddings WHERE source = $1 AND source_id = $2`,
        [doc.source, doc.sourceId]);
      const raw = rows[0]?.raw as { comments?: { author: string; body: string }[] } | null;
      const comments = raw?.comments ?? [];
      if (comments.length === 0) return doc.content;
      const longest = [...comments].sort((a, b) => b.body.length - a.body.length)[0];
      const last = comments[comments.length - 1];
      const picks = [...new Set([longest, last])];
      return `${doc.content}\n\n[thread detail]\n` +
        picks.map(c => `${c.author}: ${c.body}`).join("\n");
    }
    if (doc.kind === "code_chunk" && opts.fixturesDir) {
      const raw = (doc.metadata.path as string) ?? doc.sourceId.split("#")[0];
      const m = doc.sourceId.match(/#(\d+)-(\d+)$/);
      if (!m) return doc.content;
      const lines = readFileSync(
        join(opts.fixturesDir, "github/helios", raw), "utf8").split("\n");
      const start = Math.max(0, Number(m[1]) - 1 - 10);
      const end = Math.min(lines.length, Number(m[2]) + 10);
      return `File: ${raw} lines ${start + 1} to ${end}\n${lines.slice(start, end).join("\n")}`;
    }
    return doc.content;
  } catch {
    return doc.content;
  }
}
```

Note: thread detail comes from the `raw` column in the database, not from metadata; `raw` holds the full issue JSON for `issue_thread` rows.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/rerank-expand.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Rerank then expand: spend tokens judging winners, not losers"
```

---

### Task 5: The search pipeline with trace

**Files:**
- Create: `packages/core/src/retrieval/search.ts`
- Test: `packages/core/test/search.test.ts`
- Modify: `packages/core/src/index.ts` (append `export { search } from "./retrieval/search.js"; export type { SearchResult, SearchTrace } from "./retrieval/search.js";`)

**Interfaces:**
- Consumes: everything from Tasks 1 through 4, `embedQuery`, `loadConfig`.
- Produces:

```ts
export interface SearchTrace {
  project: string | null;
  sources: string[] | null;
  lists: { name: string; top: { sourceId: string; score: number }[] }[];
  fused: { sourceId: string; source: string; score: number;
           contributions: { list: string; rank: number; contribution: number }[] }[];
  rerank: { applied: boolean; scores: { sourceId: string; score: number }[] };
  expanded: { sourceId: string; addedChars: number }[];
}
export interface SearchResult { evidence: EvidenceRow[]; trace: SearchTrace }

export async function search(pool, query: string, opts?: {
  project?: string;
  llm?: (o: { model: string; system: string; user: string }) => Promise<string>;
  rerankModel?: string;
  fixturesDir?: string;
  limit?: number;          // default 10
}): Promise<SearchResult>
```

Pipeline order: resolve project sources (null when no project); embed the query once; run in parallel: fts, vector, rare, recency, plus one scoped vector list per project source (name `` `${source}-vector` ``, limit 10) when a project is set; fuse (limit 20); rerank top 20 when `opts.llm` present, keep the 10 best by rerank score (ties by fused order), else fused top 10; expand each winner; assemble `EvidenceRow` with `url` from `metadata.url` (fallback `` `${source}://${sourceId}` ``), `recency` = ISO date of `authoredAt` or null, `score` = rerank score when applied else fused score, `tool` = "search". Trace records each stage faithfully, including `rerank.applied = false` when skipped.

- [ ] **Step 1: Write the failing test**

`packages/core/test/search.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { getPool } from "../src/schema/db.js";
import { search } from "../src/retrieval/search.js";
import { ensureCorpus } from "./helpers.js";

const ROOT = join(import.meta.dirname, "../../..");
const pool = getPool();
beforeAll(() => ensureCorpus(pool), 600_000);
afterAll(async () => { await pool.end(); });

describe("search", () => {
  it("answers the flagship cross-source question without any LLM", async () => {
    const { evidence, trace } = await search(pool,
      "Why does checkpoint restore stall after manifest load?",
      { project: "helios-eng", fixturesDir: join(ROOT, "fixtures") });
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.length).toBeLessThanOrEqual(10);
    const ids = evidence.map(e => e.sourceId);
    expect(ids.some(id => id.startsWith("HEL-482"))).toBe(true);
    expect(ids.some(id => id.startsWith("HEL-001"))).toBe(true);
    expect(trace.rerank.applied).toBe(false);
    expect(trace.lists.map(l => l.name)).toEqual(
      expect.arrayContaining(["fts", "vector", "rare", "recency",
        "confluence-vector", "github-vector", "jira-vector"]));
    expect(trace.fused[0].contributions.length).toBeGreaterThan(0);
  });

  it("scopes to the content project", async () => {
    const { evidence } = await search(pool, "what does the launch draft say about pricing?",
      { project: "content" });
    for (const e of evidence) expect(e.source).toBe("bucket");
  });

  it("applies rerank scores when an llm is provided", async () => {
    const llm = async () =>
      JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ i, score: 20 - i > 10 ? 10 : 1 })));
    const { trace } = await search(pool, "checkpoint restore stalls",
      { llm, rerankModel: "m" });
    expect(trace.rerank.applied).toBe(true);
    expect(trace.rerank.scores.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/search.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/core/src/retrieval/search.ts`:
```ts
import type pg from "pg";
import { loadConfig } from "../schema/config.js";
import { embedQuery } from "../models/embeddings.js";
import { ftsRetriever, vectorRetriever, projectSources } from "./retrievers.js";
import { rareTokenRetriever, recencyRetriever } from "./signals.js";
import { fuse, type FusedDoc } from "./rrf.js";
import { rerank } from "./rerank.js";
import { expandDoc } from "./expand.js";
import type { EvidenceRow, RankedList } from "./types.js";

export interface SearchTrace {
  project: string | null;
  sources: string[] | null;
  lists: { name: string; top: { sourceId: string; score: number }[] }[];
  fused: { sourceId: string; source: string; score: number;
           contributions: { list: string; rank: number; contribution: number }[] }[];
  rerank: { applied: boolean; scores: { sourceId: string; score: number }[] };
  expanded: { sourceId: string; addedChars: number }[];
}

export interface SearchResult { evidence: EvidenceRow[]; trace: SearchTrace }

type Llm = (o: { model: string; system: string; user: string }) => Promise<string>;

export async function search(pool: pg.Pool, query: string, opts: {
  project?: string; llm?: Llm; rerankModel?: string;
  fixturesDir?: string; limit?: number;
} = {}): Promise<SearchResult> {
  const limit = opts.limit ?? 10;
  const sources = opts.project ? await projectSources(pool, opts.project) : null;
  const scope = sources ?? undefined;
  const qvec = await embedQuery(query);

  const listPromises: Promise<RankedList>[] = [
    ftsRetriever(pool, query, { sources: scope }),
    vectorRetriever(pool, qvec, { sources: scope }),
    rareTokenRetriever(pool, query, { sources: scope }),
    recencyRetriever(pool, qvec, { sources: scope }),
  ];
  for (const s of sources ?? [])
    listPromises.push(vectorRetriever(pool, qvec, { sources: [s], limit: 10, name: `${s}-vector` }));
  const lists = await Promise.all(listPromises);

  const fused = fuse(lists, { limit: 20 });

  let winners: FusedDoc[];
  let rerankScores = new Map<string, number>();
  let applied = false;
  if (opts.llm && fused.length > 0) {
    const model = opts.rerankModel ?? loadConfig().models.rerank;
    const scores = await rerank(query, fused, { llm: opts.llm, model });
    if (scores) {
      applied = true;
      rerankScores = scores;
      winners = [...fused]
        .map((f, i) => ({ f, i, s: scores.get(`${f.doc.source}:${f.doc.sourceId}`) ?? 0 }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, limit).map(x => x.f);
    } else {
      winners = fused.slice(0, limit);
    }
  } else {
    winners = fused.slice(0, limit);
  }

  const expanded: { sourceId: string; addedChars: number }[] = [];
  const evidence: EvidenceRow[] = [];
  for (const f of winners) {
    const content = await expandDoc(pool, f.doc, { fixturesDir: opts.fixturesDir });
    expanded.push({ sourceId: f.doc.sourceId, addedChars: content.length - f.doc.content.length });
    evidence.push({
      content,
      source: f.doc.source,
      sourceId: f.doc.sourceId,
      title: f.doc.title,
      url: (f.doc.metadata.url as string) ?? `${f.doc.source}://${f.doc.sourceId}`,
      score: applied
        ? rerankScores.get(`${f.doc.source}:${f.doc.sourceId}`) ?? 0
        : f.score,
      recency: f.doc.authoredAt ? f.doc.authoredAt.toISOString().slice(0, 10) : null,
      tool: "search",
    });
  }

  return {
    evidence,
    trace: {
      project: opts.project ?? null,
      sources,
      lists: lists.map(l => ({
        name: l.name,
        top: l.docs.slice(0, 10).map(d => ({ sourceId: d.sourceId, score: d.score })),
      })),
      fused: fused.map(f => ({
        sourceId: f.doc.sourceId, source: f.doc.source,
        score: f.score, contributions: f.contributions,
      })),
      rerank: {
        applied,
        scores: [...rerankScores.entries()].map(([k, score]) =>
          ({ sourceId: k.split(":").slice(1).join(":"), score })),
      },
      expanded,
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/search.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Wire the pipeline with a trace because the demo teaches by showing its work"
```

---

### Task 6: Tools: who_knows, search_code, per-source search, list_projects

**Files:**
- Create: `packages/core/src/answer/tools.ts`
- Test: `packages/core/test/tools.test.ts`
- Modify: `packages/core/src/index.ts` (append `export { buildTools } from "./answer/tools.js"; export type { Tool } from "./answer/tools.js";`)

**Interfaces:**
- Consumes: `search` (Task 5), `ftsRetriever`, `vectorRetriever`, `fuse`, `embedQuery`, types.
- Produces:

```ts
export interface Tool {
  name: string;
  description: string;    // one line, used verbatim in the planner catalog
  run(args: { query: string; project?: string }): Promise<EvidenceRow[]>;
}
export function buildTools(pool, opts: {
  fixturesDir: string;
  llm?: Llm;              // passed through to search for rerank
}): Tool[]
```

Six tools:
1. `search`: the full pipeline from Task 5.
2. `search_confluence`, `search_jira`: the pipeline with sources forced to that single source (implemented by calling the retrievers directly with `sources: ["confluence"]` etc. and fusing fts + vector only; no rerank; limit 5). Descriptions say what each source is good at (runbooks and RFCs; incidents and resolutions).
3. `search_code`: LLM-free literal/regex scan over `fixturesDir/github/helios`. Case-insensitive. Each hit is an EvidenceRow whose content is the matched line with 2 lines of context either side, `sourceId` = `` `${relPath}:${lineNo}` ``, `url` = `` `github://helios/${relPath}#L${lineNo}` ``, score 1, max 50 hits. Invalid regex falls back to literal substring match.
4. `who_knows`: run fts + vector (limit 30 each), fuse, take top 30, aggregate `metadata.authors` (skip "unknown"), weight each person by the sum of fused scores of docs they authored and count their docs; return people as EvidenceRows: content `` `${person} (${docs} docs)` ``, sourceId = person name, score = weight, tool = "who_knows", sorted descending, top 5.
5. `list_projects`: one EvidenceRow per project: content `` `${name}: ${description} [sources: ...]` ``.

- [ ] **Step 1: Write the failing test**

`packages/core/test/tools.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { getPool } from "../src/schema/db.js";
import { buildTools } from "../src/answer/tools.js";
import { ensureCorpus } from "./helpers.js";

const ROOT = join(import.meta.dirname, "../../..");
const pool = getPool();
const tools = buildTools(pool, { fixturesDir: join(ROOT, "fixtures") });
const get = (name: string) => tools.find(t => t.name === name)!;
beforeAll(() => ensureCorpus(pool), 600_000);
afterAll(async () => { await pool.end(); });

describe("buildTools", () => {
  it("exposes exactly the six tools", () => {
    expect(tools.map(t => t.name).sort()).toEqual([
      "list_projects", "search", "search_code", "search_confluence",
      "search_jira", "who_knows"]);
    for (const t of tools) expect(t.description.length).toBeGreaterThan(10);
  });

  it("search_code finds the prefetch flag without any LLM", async () => {
    const rows = await get("search_code").run({ query: "HELIOS_PREFETCH_DEPTH" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].content).toContain("HELIOS_PREFETCH_DEPTH");
    expect(rows[0].sourceId).toMatch(/^src\/.+:\d+$/);
  });

  it("who_knows surfaces Priya for the shard cache", async () => {
    const rows = await get("who_knows").run({ query: "shard cache" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.slice(0, 3).map(r => r.sourceId)).toContain("Priya Natarajan");
  });

  it("search_jira only returns jira evidence", async () => {
    const rows = await get("search_jira").run({ query: "manifest timeout" });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.source).toBe("jira");
  });

  it("list_projects names both projects", async () => {
    const rows = await get("list_projects").run({ query: "" });
    expect(rows.map(r => r.sourceId).sort()).toEqual(["content", "helios-eng"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/tools.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/core/src/answer/tools.ts`:
```ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type pg from "pg";
import { embedQuery } from "../models/embeddings.js";
import { ftsRetriever, vectorRetriever } from "../retrieval/retrievers.js";
import { fuse } from "../retrieval/rrf.js";
import { search } from "../retrieval/search.js";
import type { EvidenceRow } from "../retrieval/types.js";

type Llm = (o: { model: string; system: string; user: string }) => Promise<string>;

export interface Tool {
  name: string;
  description: string;
  run(args: { query: string; project?: string }): Promise<EvidenceRow[]>;
}

function walk(dir: string, base: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name), base)
      : e.name.endsWith(".ts") ? [relative(base, join(dir, e.name))] : []);
}

async function sourceSearch(
  pool: pg.Pool, source: string, query: string
): Promise<EvidenceRow[]> {
  const qvec = await embedQuery(query);
  const lists = await Promise.all([
    ftsRetriever(pool, query, { sources: [source], limit: 20 }),
    vectorRetriever(pool, qvec, { sources: [source], limit: 20 }),
  ]);
  return fuse(lists, { limit: 5 }).map(f => ({
    content: f.doc.content,
    source: f.doc.source,
    sourceId: f.doc.sourceId,
    title: f.doc.title,
    url: (f.doc.metadata.url as string) ?? `${f.doc.source}://${f.doc.sourceId}`,
    score: f.score,
    recency: f.doc.authoredAt ? f.doc.authoredAt.toISOString().slice(0, 10) : null,
    tool: `search_${source}`,
  }));
}

export function buildTools(
  pool: pg.Pool, opts: { fixturesDir: string; llm?: Llm }
): Tool[] {
  const codeRoot = join(opts.fixturesDir, "github/helios");
  return [
    {
      name: "search",
      description: "Hybrid search across all sources in scope: use for most questions.",
      run: ({ query, project }) =>
        search(pool, query, { project, llm: opts.llm, fixturesDir: opts.fixturesDir })
          .then(r => r.evidence),
    },
    {
      name: "search_confluence",
      description: "Wiki only: runbooks, RFCs, onboarding, policy pages.",
      run: ({ query }) => sourceSearch(pool, "confluence", query),
    },
    {
      name: "search_jira",
      description: "Issue tracker only: incidents, bugs, decisions and their resolutions.",
      run: ({ query }) => sourceSearch(pool, "jira", query),
    },
    {
      name: "search_code",
      description: "Exact text or regex over the Helios codebase: flags, error strings, function names.",
      run: async ({ query }) => {
        let re: RegExp;
        try { re = new RegExp(query, "i"); }
        catch { re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
        const out: EvidenceRow[] = [];
        for (const rel of walk(codeRoot, codeRoot).sort()) {
          const lines = readFileSync(join(codeRoot, rel), "utf8").split("\n");
          for (let i = 0; i < lines.length && out.length < 50; i++) {
            if (!re.test(lines[i])) continue;
            const ctx = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
            out.push({
              content: ctx, source: "github", sourceId: `${rel}:${i + 1}`,
              title: rel, url: `github://helios/${rel}#L${i + 1}`,
              score: 1, recency: null, tool: "search_code",
            });
          }
        }
        return out;
      },
    },
    {
      name: "who_knows",
      description: "Find people with demonstrated expertise on a topic, ranked by evidence.",
      run: async ({ query }) => {
        const qvec = await embedQuery(query);
        const lists = await Promise.all([
          ftsRetriever(pool, query, { limit: 30 }),
          vectorRetriever(pool, qvec, { limit: 30 }),
        ]);
        const people = new Map<string, { weight: number; docs: number }>();
        for (const f of fuse(lists, { limit: 30, maxPerParent: 3 })) {
          for (const a of (f.doc.metadata.authors as string[]) ?? []) {
            if (a === "unknown") continue;
            const p = people.get(a) ?? { weight: 0, docs: 0 };
            p.weight += f.score; p.docs += 1;
            people.set(a, p);
          }
        }
        return [...people.entries()]
          .sort((a, b) => b[1].weight - a[1].weight)
          .slice(0, 5)
          .map(([person, p]) => ({
            content: `${person} (${p.docs} docs)`, source: "people",
            sourceId: person, title: person, url: `people://${encodeURIComponent(person)}`,
            score: p.weight, recency: null, tool: "who_knows",
          }));
      },
    },
    {
      name: "list_projects",
      description: "List the available projects and which sources each one scopes to.",
      run: async () => {
        const { rows } = await pool.query(
          `SELECT p.name, p.description, array_agg(ps.source ORDER BY ps.source) AS sources
             FROM projects p LEFT JOIN project_sources ps ON ps.project = p.name
            GROUP BY p.name, p.description ORDER BY p.name`);
        return rows.map(r => ({
          content: `${r.name}: ${r.description} [sources: ${(r.sources ?? []).join(", ")}]`,
          source: "projects", sourceId: r.name as string, title: r.name as string,
          url: `project://${r.name}`, score: 1, recency: null, tool: "list_projects",
        }));
      },
    },
  ];
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/tools.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Expose retrieval as narrow tools so any agent can orchestrate them"
```

---

### Task 7: Planner, executor, synthesis

**Files:**
- Create: `packages/core/src/answer/planner.ts`, `packages/core/src/answer/ask.ts`
- Test: `packages/core/test/ask.test.ts`
- Modify: `packages/core/src/index.ts` (append `export { plan } from "./answer/planner.js"; export { ask } from "./answer/ask.js"; export type { AskResult } from "./answer/ask.js";`)

**Interfaces:**
- Consumes: `Tool`, `buildTools` (Task 6), `chatJSON`-style llm functions, `loadConfig`.
- Produces:
  - `plan(question: string, tools: Tool[], projectsCatalog: string, opts: { llm: Llm; model: string }): Promise<{ tools: { name: string; query: string }[]; reasoning: string; fallback: boolean }>`: one LLM call selecting 1 to 3 tools with per-tool query strings (default the user question). Unknown tool names are filtered; empty or failed plans fall back to `[{ name: "search", query: question }]` with `fallback: true`.
  - `ask(pool, question: string, opts: { project?: string; fixturesDir: string; llm: Llm }): Promise<AskResult>` where `AskResult = { answer: string; evidence: EvidenceRow[]; plan: { tools: { name: string; query: string }[]; reasoning: string; fallback: boolean } }`. Executor runs the planned tools in parallel via `Promise.all`, concatenates evidence (cap 20 rows, preserving tool order), numbers it 1..n, synthesizes with the synthesis model, and returns the cited answer.

- [ ] **Step 1: Write the failing test**

`packages/core/test/ask.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { getPool } from "../src/schema/db.js";
import { buildTools } from "../src/answer/tools.js";
import { plan } from "../src/answer/planner.js";
import { ask } from "../src/answer/ask.js";
import { ensureCorpus } from "./helpers.js";

const ROOT = join(import.meta.dirname, "../../..");
const pool = getPool();
const tools = buildTools(pool, { fixturesDir: join(ROOT, "fixtures") });
beforeAll(() => ensureCorpus(pool), 600_000);
afterAll(async () => { await pool.end(); });

describe("plan", () => {
  it("keeps only known tools and their queries", async () => {
    const llm = async () => JSON.stringify({
      tools: [{ name: "search_code", query: "HELIOS_PREFETCH_DEPTH" },
              { name: "made_up_tool", query: "x" }],
      reasoning: "flag lookup",
    });
    const p = await plan("what is HELIOS_PREFETCH_DEPTH?", tools, "catalog", { llm, model: "m" });
    expect(p.tools).toEqual([{ name: "search_code", query: "HELIOS_PREFETCH_DEPTH" }]);
    expect(p.fallback).toBe(false);
  });

  it("falls back to search when the planner fails", async () => {
    const llm = async () => { throw new Error("down"); };
    const p = await plan("anything", tools, "catalog", { llm, model: "m" });
    expect(p.tools).toEqual([{ name: "search", query: "anything" }]);
    expect(p.fallback).toBe(true);
  });
});

describe("ask", () => {
  it("plans, executes, and synthesizes a cited answer", async () => {
    let call = 0;
    const llm = async ({ system }: { system: string }) => {
      call++;
      if (system.includes("select the best tools"))
        return JSON.stringify({ tools: [{ name: "search", query: "checkpoint restore stalls" }],
          reasoning: "hybrid search covers it" });
      if (system.includes("score search results"))
        throw new Error("skip rerank");
      return "Restore stalls because prefetch depth saturates NFS [1]. Set HELIOS_PREFETCH_DEPTH=4 [2].";
    };
    const result = await ask(pool, "Why does checkpoint restore stall?", {
      project: "helios-eng", fixturesDir: join(ROOT, "fixtures"), llm,
    });
    expect(result.plan.tools[0].name).toBe("search");
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.answer).toContain("[1]");
    expect(call).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/ask.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/core/src/answer/planner.ts`:
```ts
import type { Tool } from "./tools.js";

type Llm = (o: { model: string; system: string; user: string }) => Promise<string>;

const SYSTEM = `You are a query planner for a knowledge base. Given a question and a
catalog of tools and projects, select the best tools to answer it.
Reply with ONLY JSON: {"tools": [{"name": "...", "query": "..."}], "reasoning": "one line"}.
Pick 1 to 3 tools. Rewrite the query per tool when it helps (an exact flag for
search_code, a topic for who_knows). Prefer plain search unless the question is
clearly about code text, people, or one specific system.`;

export async function plan(
  question: string, tools: Tool[], projectsCatalog: string,
  opts: { llm: Llm; model: string }
): Promise<{ tools: { name: string; query: string }[]; reasoning: string; fallback: boolean }> {
  const fallback = { tools: [{ name: "search", query: question }], reasoning: "fallback: plain search", fallback: true };
  const catalog = tools.map(t => `- ${t.name}: ${t.description}`).join("\n");
  try {
    const reply = await opts.llm({
      model: opts.model, system: SYSTEM,
      user: `<question>${question}</question>\n<tools>\n${catalog}\n</tools>\n<projects>\n${projectsCatalog}\n</projects>`,
    });
    const parsed = JSON.parse(reply.replace(/```(?:json)?|```/g, "").trim()) as
      { tools?: { name?: string; query?: string }[]; reasoning?: string };
    const known = new Set(tools.map(t => t.name));
    const picked = (parsed.tools ?? [])
      .filter(t => t.name && known.has(t.name))
      .slice(0, 3)
      .map(t => ({ name: t.name as string, query: t.query?.trim() || question }));
    if (picked.length === 0) return fallback;
    return { tools: picked, reasoning: parsed.reasoning ?? "", fallback: false };
  } catch {
    return fallback;
  }
}
```

`packages/core/src/answer/ask.ts`:
```ts
import type pg from "pg";
import { loadConfig } from "../schema/config.js";
import { buildTools } from "./tools.js";
import { plan } from "./planner.js";
import type { EvidenceRow } from "../retrieval/types.js";

type Llm = (o: { model: string; system: string; user: string }) => Promise<string>;

const SYNTHESIS_SYSTEM = `You answer questions from an internal knowledge base using
ONLY the numbered evidence provided. Cite evidence inline as [n] after each claim.
When evidence items disagree, say so explicitly and prefer the newer one, citing both.
When the evidence does not answer the question, say what is missing instead of guessing.
Be concise: a few sentences, no preamble.`;

export interface AskResult {
  answer: string;
  evidence: EvidenceRow[];
  plan: { tools: { name: string; query: string }[]; reasoning: string; fallback: boolean };
}

export async function ask(pool: pg.Pool, question: string, opts: {
  project?: string; fixturesDir: string; llm: Llm;
}): Promise<AskResult> {
  const cfg = loadConfig();
  const tools = buildTools(pool, { fixturesDir: opts.fixturesDir, llm: opts.llm });
  const { rows } = await pool.query(
    `SELECT name, description FROM projects ORDER BY name`);
  const projectsCatalog = rows.map(r => `- ${r.name}: ${r.description}`).join("\n");

  const p = await plan(question, tools, projectsCatalog,
    { llm: opts.llm, model: cfg.models.planner });

  const byName = new Map(tools.map(t => [t.name, t]));
  const settled = await Promise.all(p.tools.map(t =>
    byName.get(t.name)!.run({ query: t.query, project: opts.project })
      .catch(() => [] as EvidenceRow[])));
  const evidence = settled.flat().slice(0, 20);

  const numbered = evidence.map((e, i) =>
    `<evidence n="${i + 1}" source="${e.source}" url="${e.url}"` +
    `${e.recency ? ` date="${e.recency}"` : ""}>\n${e.content.slice(0, 1500)}\n</evidence>`
  ).join("\n");

  const answer = evidence.length === 0
    ? "No evidence found for this question in the knowledge base."
    : await opts.llm({
        model: cfg.models.synthesis, system: SYNTHESIS_SYSTEM,
        user: `<question>${question}</question>\n${numbered}`,
      });

  return { answer, evidence, plan: p };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/ask.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Plan, fan out, synthesize: the answer layer stays thin over the tools"
```

---

### Task 8: CLI: kb search, kb ask, kb who-knows, live verification

**Files:**
- Modify: `packages/cli/src/index.ts`

**Interfaces:**
- Consumes: `search`, `ask`, `buildTools`, `chat`, `loadConfig`, `getPool` from `@kb/core`.
- Produces: three new commands. All accept `--project <name>`. `search` accepts `--explain`, `ask` accepts `--trace`, both accept `--no-llm`.

- [ ] **Step 1: Extend the CLI**

Append to `packages/cli/src/index.ts` (before `await program.parseAsync();`), reusing the existing imports plus `search`, `ask`, `buildTools` added to the import from `@kb/core`, and `join` already imported:

```ts
const llmOrUndefined = (use: boolean) => {
  const cfg = loadConfig();
  if (!use || !cfg.cerebrasApiKey) return undefined;
  return async (o: { model: string; system: string; user: string }) => {
    await new Promise((r) => setTimeout(r, 400));
    return chat({ model: o.model, system: o.system, user: o.user, attempts: 5 });
  };
};

const fmtScore = (n: number) => n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");

program.command("search <query>")
  .description("Hybrid search with optional pipeline explanation")
  .option("--project <name>", "scope to a project")
  .option("--explain", "print each retriever list, the RRF table, and rerank scores")
  .option("--no-llm", "skip the rerank step")
  .action(async (query: string, opts: { project?: string; explain?: boolean; llm: boolean }) => {
    const pool = getPool();
    try {
      const llm = llmOrUndefined(opts.llm);
      if (opts.llm && !llm) console.log(pc.yellow("no CEREBRAS_API_KEY: rerank skipped"));
      const { evidence, trace } = await search(pool, query, {
        project: opts.project, llm, fixturesDir: join(process.cwd(), "fixtures"),
      });
      if (opts.explain) {
        for (const list of trace.lists) {
          console.log(pc.bold(`\n[${list.name}]`));
          list.top.slice(0, 5).forEach((d, i) =>
            console.log(`  ${i + 1}. ${d.sourceId.padEnd(40)} ${fmtScore(d.score)}`));
        }
        console.log(pc.bold("\n[rrf fusion] score = sum of weight / (60 + rank)"));
        for (const f of trace.fused.slice(0, 10)) {
          const parts = f.contributions
            .map(c => `${c.list}#${c.rank}:${fmtScore(c.contribution)}`).join(" + ");
          console.log(`  ${f.sourceId.padEnd(40)} ${fmtScore(f.score)}  = ${parts}`);
        }
        console.log(pc.bold(`\n[rerank] ${trace.rerank.applied ? "applied" : "skipped"}`));
        for (const s of trace.rerank.scores.slice(0, 10))
          console.log(`  ${s.sourceId.padEnd(40)} ${s.score}/10`);
      }
      console.log(pc.bold("\nresults"));
      evidence.forEach((e, i) => {
        console.log(`${i + 1}. ${pc.cyan(e.title ?? e.sourceId)} ${pc.dim(`(${e.url})`)}`);
        console.log(pc.dim(`   ${e.content.split("\n")[0]?.slice(0, 100) ?? ""}`));
      });
    } finally {
      await pool.end();
    }
  });

program.command("ask <question>")
  .description("Planner, executor, synthesis: a cited answer")
  .option("--project <name>", "scope to a project")
  .option("--trace", "print the planner decision and evidence table")
  .action(async (question: string, opts: { project?: string; trace?: boolean }) => {
    const pool = getPool();
    try {
      const llm = llmOrUndefined(true);
      if (!llm) {
        console.log(pc.red("kb ask needs CEREBRAS_API_KEY (retrieval-only mode: use kb search)"));
        return;
      }
      const result = await ask(pool, question, {
        project: opts.project, fixturesDir: join(process.cwd(), "fixtures"), llm,
      });
      if (opts.trace) {
        console.log(pc.bold("[planner] ") + result.plan.reasoning +
          (result.plan.fallback ? pc.yellow(" (fallback)") : ""));
        for (const t of result.plan.tools) console.log(pc.dim(`  ${t.name}("${t.query}")`));
        console.log(pc.bold("\n[evidence]"));
        result.evidence.forEach((e, i) =>
          console.log(pc.dim(`  [${i + 1}] ${e.source} ${e.sourceId} ${e.url}`)));
      }
      console.log(pc.bold("\nanswer\n") + result.answer);
      console.log(pc.dim("\ncitations"));
      result.evidence.forEach((e, i) =>
        console.log(pc.dim(`  [${i + 1}] ${e.url}`)));
    } finally {
      await pool.end();
    }
  });

program.command("who-knows <topic>")
  .description("People with demonstrated expertise on a topic")
  .action(async (topic: string) => {
    const pool = getPool();
    try {
      const tools = buildTools(pool, { fixturesDir: join(process.cwd(), "fixtures") });
      const rows = await tools.find(t => t.name === "who_knows")!.run({ query: topic });
      if (rows.length === 0) { console.log("no signal for that topic"); return; }
      for (const r of rows)
        console.log(`${pc.cyan(r.sourceId.padEnd(20))} ${pc.dim(r.content)}`);
    } finally {
      await pool.end();
    }
  });
```

- [ ] **Step 2: Typecheck and full suite**

Run: `pnpm typecheck && pnpm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 3: Live verification against the real store**

The live `kb` database holds the fully distilled corpus. Run and record output of each:

1. `pnpm kb search "restore hangs after manifest load" --project helios-eng --explain` : expect the fusion table, and HEL-482 or HEL-001 in the top results.
2. `pnpm kb search "ERR_MANIFEST_TIMEOUT" --explain --no-llm` : expect the fts list to lead with HEL-530 material.
3. `pnpm kb ask "How long do we retain checkpoints?" --project helios-eng --trace` : expect an answer that cites both the wiki policy and the newer JIRA decision and notes the conflict.
4. `pnpm kb who-knows "shard cache"` : expect Priya Natarajan first or second.

If any of the four disappoints (wrong evidence, missing conflict caveat), record what happened; tuning belongs in this task only if the cause is a wiring bug, not ranking quality (ranking tuning is eval work, Task 9).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Give the CLI eyes into every stage because the trace is the curriculum"
```

---

### Task 9: Golden-question eval: CI test and live scorecard

**Files:**
- Create: `packages/core/src/answer/golden.ts`, `packages/core/test/zeval.test.ts`, `eval/run.ts`
- Modify: `packages/core/src/index.ts` (append `export { loadGolden, gradeQuestion } from "./answer/golden.js"; export type { GoldenQuestion, Grade } from "./answer/golden.js";`), root `package.json` (add script `"eval": "tsx eval/run.ts"` and dependency `"@kb/core": "workspace:*"`, then `pnpm install` so `eval/run.ts` can import it)

**Interfaces:**
- Consumes: `search`, `buildTools`, types.
- Produces:
  - `GoldenQuestion { id: string; project: string; question: string; note?: string; expect?: { source: string; sourceIdPrefix: string }[]; expectPeople?: string[] }`
  - `loadGolden(path: string): GoldenQuestion[]`
  - `gradeQuestion(pool, q: GoldenQuestion, opts: { fixturesDir: string; llm?: Llm }): Promise<Grade>` where `Grade = { id: string; pass: boolean; details: string[] }`. An `expect` item passes when any of the top 10 evidence rows has the same source and a sourceId starting with the prefix (for github, the code_chunk sourceId starts with the file path). `expectPeople` passes when each person appears in who_knows top 3. A question passes when every expectation passes.
- The grader lives in `answer/` (not `retrieval/`) because it exercises both `search` and the `who_knows` tool; retrieval must not import from the answer layer.

- [ ] **Step 1: Write the failing test**

`packages/core/test/zeval.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { getPool } from "../src/schema/db.js";
import { loadGolden, gradeQuestion } from "../src/answer/golden.js";
import { ensureCorpus } from "./helpers.js";

const ROOT = join(import.meta.dirname, "../../..");
const pool = getPool();
beforeAll(() => ensureCorpus(pool), 600_000);
afterAll(async () => { await pool.end(); });

describe("golden questions, retrieval only, raw-text corpus", () => {
  it("passes at least 8 of 10", { timeout: 300_000 }, async () => {
    const questions = loadGolden(join(ROOT, "eval/golden.json"));
    expect(questions).toHaveLength(10);
    const grades = [];
    for (const q of questions)
      grades.push(await gradeQuestion(pool, q, { fixturesDir: join(ROOT, "fixtures") }));
    const failed = grades.filter(g => !g.pass);
    expect(failed.length,
      `failed: ${failed.map(g => `${g.id} (${g.details.join("; ")})`).join(" | ")}`
    ).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/zeval.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the grader and the scorecard**

`packages/core/src/answer/golden.ts`:
```ts
import { readFileSync } from "node:fs";
import type pg from "pg";
import { search } from "../retrieval/search.js";
import { buildTools } from "./tools.js";

type Llm = (o: { model: string; system: string; user: string }) => Promise<string>;

export interface GoldenQuestion {
  id: string; project: string; question: string; note?: string;
  expect?: { source: string; sourceIdPrefix: string }[];
  expectPeople?: string[];
}

export interface Grade { id: string; pass: boolean; details: string[] }

export function loadGolden(path: string): GoldenQuestion[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { questions: GoldenQuestion[] }).questions;
}

export async function gradeQuestion(
  pool: pg.Pool, q: GoldenQuestion,
  opts: { fixturesDir: string; llm?: Llm }
): Promise<Grade> {
  const details: string[] = [];
  let pass = true;

  if (q.expect?.length) {
    const { evidence } = await search(pool, q.question, {
      project: q.project, llm: opts.llm, fixturesDir: opts.fixturesDir,
    });
    for (const e of q.expect) {
      const hit = evidence.some(r =>
        r.source === e.source && r.sourceId.startsWith(e.sourceIdPrefix));
      if (!hit) { pass = false; details.push(`missing ${e.source}:${e.sourceIdPrefix}`); }
    }
  }

  if (q.expectPeople?.length) {
    const tools = buildTools(pool, { fixturesDir: opts.fixturesDir });
    const people = await tools.find(t => t.name === "who_knows")!.run({ query: q.question });
    const top3 = people.slice(0, 3).map(p => p.sourceId);
    for (const person of q.expectPeople) {
      if (!top3.includes(person)) { pass = false; details.push(`${person} not in top 3`); }
    }
  }

  return { id: q.id, pass, details };
}
```

`eval/run.ts`:
```ts
import { join } from "node:path";
import { getPool, loadGolden, gradeQuestion, loadConfig, chat } from "@kb/core";

const live = process.argv.includes("--live");
const ROOT = join(import.meta.dirname, "..");

const pool = getPool();
const cfg = loadConfig();
const llm = live && cfg.cerebrasApiKey
  ? async (o: { model: string; system: string; user: string }) => {
      await new Promise((r) => setTimeout(r, 400));
      return chat({ model: o.model, system: o.system, user: o.user, attempts: 5 });
    }
  : undefined;

if (live && !llm) {
  console.error("--live needs CEREBRAS_API_KEY");
  process.exit(2);
}

const questions = loadGolden(join(ROOT, "eval/golden.json"));
let passed = 0;
console.log(`golden eval, ${live ? "live rerank" : "retrieval only"}, db: ${cfg.databaseUrl}\n`);
for (const q of questions) {
  const g = await gradeQuestion(pool, q, { fixturesDir: join(ROOT, "fixtures"), llm });
  if (g.pass) passed++;
  console.log(`${g.pass ? "PASS" : "FAIL"}  ${q.id.padEnd(20)} ${g.details.join("; ")}`);
}
console.log(`\n${passed}/${questions.length} passed`);
await pool.end();
process.exit(passed >= 8 ? 0 : 1);
```

Root `package.json` scripts gain `"eval": "tsx eval/run.ts"`.

- [ ] **Step 4: Run the CI-mode test, then the live scorecard**

Run: `pnpm vitest run packages/core/test/zeval.test.ts`
Expected: PASS. If more than 2 questions fail, the failure message names them; fix ranking or fixtures, do not loosen the threshold. Common causes: a scoped list crowding out a cross-source hit, or the rare-token threshold filtering a needed flag.

Run: `pnpm eval` then `pnpm eval --live`
Expected: 8+/10 in both modes against the live distilled store; live mode should match or beat retrieval-only. Record both scorecards in the task report.

- [ ] **Step 5: Full suite and commit**

Run: `pnpm test && pnpm typecheck`
Expected: all green.

```bash
git add -A && git commit -m "Grade retrieval against golden questions so quality is a number, not a vibe"
```

---

## Done means

`kb search --explain` shows five retriever lists fusing into a scored table, `kb ask --trace` walks planner to cited answer live against Cerebras, `kb who-knows` ranks the right people, and `pnpm eval --live` prints 8+/10. Plan 3 adds MCP, the web UI, and the teaching docs on top of exactly these functions.
