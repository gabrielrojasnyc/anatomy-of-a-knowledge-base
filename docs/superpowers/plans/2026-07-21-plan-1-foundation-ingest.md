# Plan 1 of 3: Foundation and Ingest

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running pgvector store fed by four fixture connectors with LLM distillation, ending with a working `kb init` and `kb ingest`.

**Architecture:** pnpm monorepo. `packages/core` holds schema, model clients, and ingest as a library. `packages/cli` is a thin front door. Fixtures are data, excluded from builds. Every LLM call degrades visibly, never silently.

**Tech Stack:** Node 22, TypeScript 5 (ESM), pnpm, pg, @huggingface/transformers, commander, picocolors, vitest, tsx, Postgres 17 + pgvector via Podman.

## Global Constraints

- No em dashes and no double dashes in any prose, docs, comments, or commit messages. CLI flags like `--source` are code, not prose, and are fine.
- All packages ESM: `"type": "module"` everywhere. Imports use `.js` extensions in relative paths (TS `nodenext` resolution).
- Database on port 5433 to avoid clashing with any local Postgres.
- `CEREBRAS_API_KEY` is read from `.env` at repo root; never committed. Everything except distillation must work without it.
- Embedding model is `Xenova/bge-small-en-v1.5`, 384 dimensions. First use downloads ~34 MB to `~/.cache/huggingface`; tests that embed are integration tests, not unit tests.
- Commit after every task. Commit messages explain why, not what.
- Podman, not Docker. Compose via `podman compose`.

---

### Task 1: Scaffold, compose, database up

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `compose.yaml`, `.env.example`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `vitest.config.ts`

**Interfaces:**
- Produces: workspace layout every later task lives in; running Postgres at `postgres://kb:kb@localhost:5433/kb`.

- [ ] **Step 1: Write workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
```

`package.json`:
```json
{
  "name": "anatomy-of-a-knowledge-base",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -b packages/core"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "tsx": "^4.19.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "composite": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

`packages/core/package.json`:
```json
{
  "name": "@kb/core",
  "version": "0.0.1",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@huggingface/transformers": "^4.2.0",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/core/src/index.ts`:
```ts
export {};
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
```

`compose.yaml`:
```yaml
services:
  db:
    image: docker.io/pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: kb
      POSTGRES_PASSWORD: kb
      POSTGRES_DB: kb
    ports:
      - "5433:5432"
    volumes:
      - kbdata:/var/lib/postgresql/data
volumes:
  kbdata:
```

`.env.example`:
```
CEREBRAS_API_KEY=csk-your-key-here
DATABASE_URL=postgres://kb:kb@localhost:5433/kb
```

- [ ] **Step 2: Install and start the database**

Run: `pnpm install` (if pnpm missing: `corepack enable && corepack prepare pnpm@latest --activate`)
Run: `podman compose up -d && sleep 3 && podman compose ps`
Expected: `db` service running.

- [ ] **Step 3: Verify pgvector is present**

Run: `podman exec -it $(podman ps -qf name=db) psql -U kb -d kb -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT extversion FROM pg_extension WHERE extname='vector';"`
Expected: one row with a version like `0.8.x`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Scaffold workspace and database so every later task has a running target"
```

---

### Task 2: Config, db client, migrations, schema

**Files:**
- Create: `packages/core/src/schema/config.ts`, `packages/core/src/schema/db.ts`, `packages/core/src/schema/migrate.ts`, `packages/core/src/schema/migrations/001_init.sql`, `packages/core/src/schema/types.ts`
- Test: `packages/core/test/schema.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `loadConfig(): Config` with `{ databaseUrl, cerebrasApiKey?, models: { distill, planner, rerank, synthesis } }`; `getPool(): pg.Pool`; `migrate(pool): Promise<void>`; types `RawItem { sourceId, title, payload, authoredAt }`, `EmbeddingInsert { source, sourceId, kind, title, content, raw, metadata, authoredAt, contentHash, embedding }`, `Connector { source: string; discover(): AsyncIterable<RawItem>; distill(item: RawItem, ctx: DistillCtx): Promise<DistilledDoc[]> }`, `DistilledDoc = Omit<EmbeddingInsert, "embedding" | "contentHash">`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/schema.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../src/schema/db.js";
import { migrate } from "../src/schema/migrate.js";

const pool = getPool();

describe("schema", () => {
  beforeAll(async () => { await migrate(pool); });
  afterAll(async () => { await pool.end(); });

  it("creates all five tables", async () => {
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
    );
    const names = rows.map(r => r.tablename);
    for (const t of ["embeddings", "projects", "project_sources", "sources", "token_idf"])
      expect(names).toContain(t);
  });

  it("is idempotent", async () => {
    await migrate(pool);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM schema_migrations`);
    expect(rows[0].n).toBe(1);
  });

  it("accepts a 384-dim vector and rejects other sizes", async () => {
    const v = `[${Array(384).fill(0.1).join(",")}]`;
    await pool.query(
      `INSERT INTO embeddings (source, source_id, kind, title, content, metadata, content_hash, embedding)
       VALUES ('bucket','t1','doc_section','t','hello world','{}','h1',$1)
       ON CONFLICT (source, source_id) DO NOTHING`, [v]
    );
    await expect(
      pool.query(`UPDATE embeddings SET embedding='[1,2,3]' WHERE source_id='t1'`)
    ).rejects.toThrow();
    await pool.query(`DELETE FROM embeddings WHERE source_id='t1'`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/schema.test.ts`
Expected: FAIL, cannot find `../src/schema/db.js`.

- [ ] **Step 3: Implement config, db, migrate, and the SQL**

`packages/core/src/schema/config.ts`:
```ts
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  databaseUrl: string;
  cerebrasApiKey?: string;
  cerebrasBaseUrl: string;
  models: { distill: string; planner: string; rerank: string; synthesis: string };
}

function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

export function loadConfig(): Config {
  loadDotEnv();
  return {
    databaseUrl: process.env.DATABASE_URL ?? "postgres://kb:kb@localhost:5433/kb",
    cerebrasApiKey: process.env.CEREBRAS_API_KEY,
    cerebrasBaseUrl: process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1",
    models: {
      distill: process.env.KB_MODEL_DISTILL ?? "gpt-oss-120b",
      planner: process.env.KB_MODEL_PLANNER ?? "gemma-4-31b",
      rerank: process.env.KB_MODEL_RERANK ?? "gemma-4-31b",
      synthesis: process.env.KB_MODEL_SYNTHESIS ?? "zai-glm-4.7",
    },
  };
}
```

`packages/core/src/schema/db.ts`:
```ts
import pg from "pg";
import { loadConfig } from "./config.js";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: loadConfig().databaseUrl, max: 10 });
  return pool;
}
```

`packages/core/src/schema/migrate.ts`:
```ts
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set(
    (await pool.query(`SELECT name FROM schema_migrations`)).rows.map(r => r.name)
  );
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(readFileSync(join(dir, file), "utf8"));
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
```

`packages/core/src/schema/migrations/001_init.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE embeddings (
  id            bigserial PRIMARY KEY,
  source        text NOT NULL,
  source_id     text NOT NULL,
  kind          text NOT NULL,
  title         text,
  content       text NOT NULL,
  raw           jsonb,
  metadata      jsonb NOT NULL DEFAULT '{}',
  authored_at   timestamptz,
  content_hash  text NOT NULL,
  embedding     vector(384),
  tsv           tsvector GENERATED ALWAYS AS
                (to_tsvector('english', coalesce(title,'') || ' ' || content)) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);

CREATE INDEX embeddings_hnsw ON embeddings
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX embeddings_tsv ON embeddings USING gin (tsv);
CREATE INDEX embeddings_source ON embeddings (source);

CREATE TABLE sources (
  name         text PRIMARY KEY,
  config       jsonb NOT NULL DEFAULT '{}',
  last_synced  timestamptz
);

CREATE TABLE projects (
  name        text PRIMARY KEY,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE project_sources (
  project text NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  source  text NOT NULL REFERENCES sources(name) ON DELETE CASCADE,
  PRIMARY KEY (project, source)
);

CREATE TABLE token_idf (
  token text PRIMARY KEY,
  doc_count int NOT NULL,
  idf real NOT NULL
);
```

`packages/core/src/schema/types.ts`:
```ts
export interface RawItem {
  sourceId: string;
  title: string;
  payload: unknown;
  authoredAt?: Date;
}

export interface DistillCtx {
  llm?: (opts: { model: string; system: string; user: string }) => Promise<string>;
  model: string;
  log: (msg: string) => void;
}

export interface DistilledDoc {
  source: string;
  sourceId: string;
  kind: "page_section" | "issue_thread" | "comment_burst" | "code_chunk" | "doc_section";
  title: string | null;
  content: string;
  raw: unknown;
  metadata: Record<string, unknown>;
  authoredAt: Date | null;
}

export interface Connector {
  source: string;
  discover(): AsyncIterable<RawItem>;
  distill(item: RawItem, ctx: DistillCtx): Promise<DistilledDoc[]>;
}
```

`packages/core/src/index.ts`:
```ts
export * from "./schema/types.js";
export { loadConfig } from "./schema/config.js";
export { getPool } from "./schema/db.js";
export { migrate } from "./schema/migrate.js";
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add the single-table schema because one queryable surface is the core design bet"
```

---

### Task 3: Cerebras client with retry and JSON discipline

**Files:**
- Create: `packages/core/src/models/cerebras.ts`
- Test: `packages/core/test/cerebras.test.ts`
- Modify: `packages/core/src/index.ts` (add `export { chat, chatJSON } from "./models/cerebras.js";`)

**Interfaces:**
- Produces: `chat(opts: { model, system, user, apiKey?, baseUrl?, maxTokens? }): Promise<string>` and `chatJSON<T>(opts same + validate: (x: unknown) => T): Promise<T>`. Both throw `CerebrasError` after 3 attempts. `chatJSON` strips markdown fences and retries once with a repair prompt on parse failure.

- [ ] **Step 1: Write the failing test**

`packages/core/test/cerebras.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { chat, chatJSON, CerebrasError } from "../src/models/cerebras.js";

const ok = (content: string) => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});
const fail = (status: number) => ({ ok: false, status, text: async () => "err" });

afterEach(() => vi.unstubAllGlobals());

describe("cerebras client", () => {
  it("returns content on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok("hello")));
    expect(await chat({ model: "m", system: "s", user: "u", apiKey: "k" })).toBe("hello");
  });

  it("retries on 429 then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(fail(429)).mockResolvedValue(ok("hi"));
    vi.stubGlobal("fetch", f);
    expect(await chat({ model: "m", system: "s", user: "u", apiKey: "k", retryDelayMs: 1 })).toBe("hi");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("throws CerebrasError after 3 failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(500)));
    await expect(chat({ model: "m", system: "s", user: "u", apiKey: "k", retryDelayMs: 1 }))
      .rejects.toBeInstanceOf(CerebrasError);
  });

  it("chatJSON strips fences and validates", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok('```json\n{"a":1}\n```')));
    const out = await chatJSON({
      model: "m", system: "s", user: "u", apiKey: "k",
      validate: (x: unknown) => x as { a: number },
    });
    expect(out.a).toBe(1);
  });

  it("chatJSON repairs invalid JSON with one extra call", async () => {
    const f = vi.fn().mockResolvedValueOnce(ok("not json")).mockResolvedValue(ok('{"a":2}'));
    vi.stubGlobal("fetch", f);
    const out = await chatJSON({
      model: "m", system: "s", user: "u", apiKey: "k", retryDelayMs: 1,
      validate: (x: unknown) => x as { a: number },
    });
    expect(out.a).toBe(2);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/cerebras.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/core/src/models/cerebras.ts`:
```ts
import { loadConfig } from "../schema/config.js";

export class CerebrasError extends Error {
  constructor(msg: string, public status?: number) { super(msg); }
}

export interface ChatOpts {
  model: string;
  system: string;
  user: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function chat(opts: ChatOpts): Promise<string> {
  const cfg = loadConfig();
  const apiKey = opts.apiKey ?? cfg.cerebrasApiKey;
  if (!apiKey) throw new CerebrasError("CEREBRAS_API_KEY is not set");
  const url = `${opts.baseUrl ?? cfg.cerebrasBaseUrl}/chat/completions`;
  const delay = opts.retryDelayMs ?? 1000;

  let lastErr: CerebrasError | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(delay * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
          max_completion_tokens: opts.maxTokens ?? 4096,
        }),
      });
      if (!res.ok) {
        lastErr = new CerebrasError(`Cerebras HTTP ${res.status}`, res.status);
        continue;
      }
      const body = await res.json() as { choices: { message: { content: string } }[] };
      return body.choices[0].message.content;
    } catch (e) {
      lastErr = e instanceof CerebrasError ? e : new CerebrasError(String(e));
    }
  }
  throw lastErr ?? new CerebrasError("unreachable");
}

function stripFences(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

export async function chatJSON<T>(
  opts: ChatOpts & { validate: (x: unknown) => T }
): Promise<T> {
  const first = await chat(opts);
  try {
    return opts.validate(JSON.parse(stripFences(first)));
  } catch {
    const repaired = await chat({
      ...opts,
      user: `${opts.user}\n\nYour previous reply was not valid JSON. Reply with ONLY valid JSON, no prose, no fences.`,
    });
    return opts.validate(JSON.parse(stripFences(repaired)));
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/cerebras.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Wrap Cerebras in plain fetch so the demo shows an LLM API is just HTTP"
```

---

### Task 4: Local embeddings

**Files:**
- Create: `packages/core/src/models/embeddings.ts`
- Test: `packages/core/test/embeddings.test.ts`
- Modify: `packages/core/src/index.ts` (add `export { embedDocs, embedQuery } from "./models/embeddings.js";`)

**Interfaces:**
- Produces: `embedDocs(texts: string[]): Promise<number[][]>` (batched, 384-dim, L2-normalized) and `embedQuery(text: string): Promise<number[]>`. bge models want queries prefixed; `embedQuery` prepends `"Represent this sentence for searching relevant passages: "`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/embeddings.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { embedDocs, embedQuery } from "../src/models/embeddings.js";

const cosine = (a: number[], b: number[]) =>
  a.reduce((s, x, i) => s + x * b[i], 0);

describe("local embeddings", () => {
  it("produces 384-dim normalized vectors", async () => {
    const [v] = await embedDocs(["checkpoint restore stalls on NFS"]);
    expect(v).toHaveLength(384);
    expect(cosine(v, v)).toBeCloseTo(1, 3);
  });

  it("ranks paraphrase above unrelated text", async () => {
    const q = await embedQuery("restore hangs after manifest load");
    const [para, junk] = await embedDocs([
      "checkpoint stalls on the NFS mount during restore",
      "the cafeteria menu changes on Tuesdays",
    ]);
    expect(cosine(q, para)).toBeGreaterThan(cosine(q, junk));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/embeddings.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/core/src/models/embeddings.ts`:
```ts
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

const MODEL = "Xenova/bge-small-en-v1.5";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

let extractor: Promise<FeatureExtractionPipeline> | undefined;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractor ??= pipeline("feature-extraction", MODEL) as Promise<FeatureExtractionPipeline>;
  return extractor;
}

export async function embedDocs(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extract = await getExtractor();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const t = await extract(batch, { pooling: "mean", normalize: true });
    out.push(...(t.tolist() as number[][]));
  }
  return out;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await embedDocs([QUERY_PREFIX + text]);
  return v;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/embeddings.test.ts`
Expected: PASS (2 tests). First run downloads the model, allow a minute.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Embed locally so retrieval needs no API key and no network"
```

---

### Task 5: Tokenizer and IDF statistics

**Files:**
- Create: `packages/core/src/ingest/idf.ts`
- Test: `packages/core/test/idf.test.ts`
- Modify: `packages/core/src/index.ts` (add `export { tokenize, computeIdf, rebuildTokenIdf, maxIdf } from "./ingest/idf.js";`)

**Interfaces:**
- Produces: `tokenize(text: string): string[]` (lowercase, alphanumeric plus `_`, length >= 3, stopwords removed, deduped per doc for IDF purposes); `computeIdf(docs: string[][]): Map<string, { docCount: number; idf: number }>` using `idf = ln(N / docCount)`; `rebuildTokenIdf(pool): Promise<number>` reading `embeddings.content`, rewriting `token_idf`, returning token count; `maxIdf(pool, tokens: string[]): Promise<number>`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/idf.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { tokenize, computeIdf } from "../src/ingest/idf.js";

describe("tokenize", () => {
  it("lowercases, keeps identifiers, drops stopwords and short tokens", () => {
    expect(tokenize("Set CKPT_PREFETCH=4 for the NFS mount")).toEqual(
      ["set", "ckpt_prefetch", "nfs", "mount"]
    );
  });
});

describe("computeIdf", () => {
  it("matches hand-computed values", () => {
    const docs = [
      tokenize("checkpoint restore stalls"),
      tokenize("checkpoint format documentation"),
      tokenize("cafeteria menu tuesday"),
    ];
    const idf = computeIdf(docs);
    expect(idf.get("checkpoint")!.docCount).toBe(2);
    expect(idf.get("checkpoint")!.idf).toBeCloseTo(Math.log(3 / 2), 5);
    expect(idf.get("cafeteria")!.idf).toBeCloseTo(Math.log(3), 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/idf.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/core/src/ingest/idf.ts`:
```ts
import type pg from "pg";

const STOPWORDS = new Set(("a an and are as at be but by for from has have i in is it its of on " +
  "or that the this to was were will with you your we our they he she not no yes do does did " +
  "can could should would may might just also very").split(" "));

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

export function computeIdf(docs: string[][]): Map<string, { docCount: number; idf: number }> {
  const counts = new Map<string, number>();
  for (const doc of docs)
    for (const tok of new Set(doc)) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  const n = docs.length;
  const out = new Map<string, { docCount: number; idf: number }>();
  for (const [tok, c] of counts) out.set(tok, { docCount: c, idf: Math.log(n / c) });
  return out;
}

export async function rebuildTokenIdf(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query(`SELECT content FROM embeddings`);
  const idf = computeIdf(rows.map(r => tokenize(r.content)));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`TRUNCATE token_idf`);
    const entries = [...idf.entries()];
    for (let i = 0; i < entries.length; i += 1000) {
      const batch = entries.slice(i, i + 1000);
      const values: unknown[] = [];
      const tuples = batch.map(([tok, s], j) => {
        values.push(tok, s.docCount, s.idf);
        return `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`;
      });
      await client.query(
        `INSERT INTO token_idf (token, doc_count, idf) VALUES ${tuples.join(",")}`, values
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return idf.size;
}

export async function maxIdf(pool: pg.Pool, tokens: string[]): Promise<number> {
  if (tokens.length === 0) return 0;
  const { rows } = await pool.query(
    `SELECT coalesce(max(idf), 0) AS m FROM token_idf WHERE token = ANY($1)`, [tokens]
  );
  return Number(rows[0].m);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/idf.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add IDF stats because rare tokens are the cheapest relevance signal we have"
```

---

### Task 6: Chunkers

**Files:**
- Create: `packages/core/src/ingest/chunk.ts`
- Test: `packages/core/test/chunk.test.ts`
- Modify: `packages/core/src/index.ts` (add `export { splitMarkdownSections, chunkTypeScript } from "./ingest/chunk.js";`)

**Interfaces:**
- Produces: `splitMarkdownSections(md: string): { heading: string | null; body: string; index: number }[]` splitting on `#`/`##`/`###` lines, preamble before the first heading gets `heading: null`; `chunkTypeScript(code: string, maxChars = 2000): { text: string; startLine: number; endLine: number; boundary: "class" | "function" | "block" }[]` trying class boundaries first, then function/method, then fixed blocks of 60 lines, only descending when a chunk exceeds `maxChars`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/chunk.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { splitMarkdownSections, chunkTypeScript } from "../src/ingest/chunk.js";

describe("splitMarkdownSections", () => {
  it("splits on headings and keeps order", () => {
    const md = "intro text\n\n## Setup\nsteps here\n\n## Troubleshooting\nfix things\n";
    const s = splitMarkdownSections(md);
    expect(s.map(x => x.heading)).toEqual([null, "Setup", "Troubleshooting"]);
    expect(s.map(x => x.index)).toEqual([0, 1, 2]);
    expect(s[1].body).toContain("steps here");
  });
});

describe("chunkTypeScript", () => {
  const small = `export class Foo {\n  bar(): number { return 1; }\n}\n`;
  it("keeps a small class as one class-boundary chunk", () => {
    const c = chunkTypeScript(small);
    expect(c).toHaveLength(1);
    expect(c[0].boundary).toBe("class");
  });

  it("descends to function boundaries when a class is too large", () => {
    const big = `export class Big {\n` +
      `  one(): string {\n${"    const x = 1;\n".repeat(20)}    return "a";\n  }\n` +
      `  two(): string {\n${"    const y = 2;\n".repeat(20)}    return "b";\n  }\n}\n`;
    const c = chunkTypeScript(big, 500);
    expect(c.length).toBeGreaterThan(1);
    expect(c.some(x => x.boundary === "function")).toBe(true);
  });

  it("chunks plain statement files as blocks", () => {
    const flat = "const a = 1;\n".repeat(200);
    const c = chunkTypeScript(flat, 500);
    expect(c.length).toBeGreaterThan(1);
    expect(c.every(x => x.boundary === "block")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/chunk.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/core/src/ingest/chunk.ts`:
```ts
export interface MdSection { heading: string | null; body: string; index: number }

export function splitMarkdownSections(md: string): MdSection[] {
  const lines = md.split("\n");
  const sections: MdSection[] = [];
  let heading: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body || heading !== null)
      sections.push({ heading, body, index: sections.length });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^#{1,3}\s+(.*)$/);
    if (m) { flush(); heading = m[1].trim(); } else buf.push(line);
  }
  flush();
  return sections;
}

export interface CodeChunk {
  text: string; startLine: number; endLine: number;
  boundary: "class" | "function" | "block";
}

interface Span { start: number; end: number }

function matchSpans(lines: string[], re: RegExp): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    let depth = 0, seen = false, end = i;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") { depth++; seen = true; }
        if (ch === "}") depth--;
      }
      if (seen && depth <= 0) { end = j; break; }
      end = j;
    }
    spans.push({ start: i, end });
    i = end;
  }
  return spans;
}

const CLASS_RE = /^\s*(export\s+)?(abstract\s+)?class\s+\w+/;
const FN_RE = /^\s*(export\s+)?(async\s+)?(function\s+\w+|(public|private|protected)?\s*\w+\s*\([^)]*\)\s*:?[^;{]*\{|const\s+\w+\s*=\s*(async\s*)?\()/;

function blocks(lines: string[], offset: number, size = 60): CodeChunk[] {
  const out: CodeChunk[] = [];
  for (let i = 0; i < lines.length; i += size) {
    const slice = lines.slice(i, i + size);
    if (slice.join("\n").trim() === "") continue;
    out.push({
      text: slice.join("\n"),
      startLine: offset + i + 1,
      endLine: offset + Math.min(i + size, lines.length),
      boundary: "block",
    });
  }
  return out;
}

function chunkSpan(
  lines: string[], offset: number, maxChars: number,
  level: "class" | "function" | "block"
): CodeChunk[] {
  const text = lines.join("\n");
  if (level === "block") return blocks(lines, offset);
  const re = level === "class" ? CLASS_RE : FN_RE;
  const next = level === "class" ? "function" as const : "block" as const;
  const spans = matchSpans(lines, re);
  if (spans.length === 0) return chunkSpan(lines, offset, maxChars, next);
  const out: CodeChunk[] = [];
  let cursor = 0;
  const emit = (start: number, end: number, boundary: CodeChunk["boundary"]) => {
    const t = lines.slice(start, end + 1).join("\n");
    if (t.trim() === "") return;
    if (t.length > maxChars)
      out.push(...chunkSpan(lines.slice(start, end + 1), offset + start, maxChars, next));
    else
      out.push({ text: t, startLine: offset + start + 1, endLine: offset + end + 1, boundary });
  };
  for (const s of spans) {
    if (s.start > cursor) emit(cursor, s.start - 1, "block");
    emit(s.start, s.end, level);
    cursor = s.end + 1;
  }
  if (cursor < lines.length) emit(cursor, lines.length - 1, "block");
  if (text.length <= maxChars && out.length > 1)
    return [{ text, startLine: offset + 1, endLine: offset + lines.length, boundary: level }];
  return out;
}

export function chunkTypeScript(code: string, maxChars = 2000): CodeChunk[] {
  return chunkSpan(code.split("\n"), 0, maxChars, "class");
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/chunk.test.ts`
Expected: PASS (4 tests). The chunker is regex-based on purpose; docs will contrast it with tree-sitter at scale.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Chunk code coarse to fine so retrieval hits whole ideas, not windows"
```

---

### Task 7: Golden questions, fixture exemplars, fixture lint

**Files:**
- Create: `eval/golden.json`, `fixtures/projects.json`, `fixtures/confluence/HEL-001.json`, `fixtures/jira/HEL-482.json`, `fixtures/bucket/launch-pricing-draft.md`, `fixtures/github/helios/src/checkpoint/loader.ts`, `fixtures/github/helios/src/checkpoint/manifest.ts`
- Test: `packages/core/test/fixtures.test.ts`

**Interfaces:**
- Produces: fixture JSON shapes every connector parses; `eval/golden.json` consumed by Plan 2's eval harness; the lint test that Task 8 runs until green.

- [ ] **Step 1: Write the shared cast and projects file**

`fixtures/projects.json`:
```json
{
  "projects": [
    { "name": "helios-eng", "description": "Helios engineering: runbooks, tickets, code", "sources": ["confluence", "jira", "github"] },
    { "name": "content", "description": "Production Notes and company content", "sources": ["bucket"] }
  ]
}
```

The recurring cast, reused across all fixtures so `who_knows` has signal: Maya Okafor (infra), Priya Natarajan (storage), Owen Reyes (serving), Sam Whitfield (platform), Jonah Kim (compiler), Elena Petrova (SRE), Gabe Rojas (content). Use only these names.

- [ ] **Step 2: Write golden.json with all ten questions**

`eval/golden.json`:
```json
{
  "questions": [
    { "id": "restore-stall", "project": "helios-eng",
      "question": "Why does checkpoint restore stall after manifest load?",
      "expect": [
        { "source": "jira", "sourceIdPrefix": "HEL-482" },
        { "source": "confluence", "sourceIdPrefix": "HEL-001" },
        { "source": "github", "sourceIdPrefix": "src/checkpoint/loader.ts" } ] },
    { "id": "retention-conflict", "project": "helios-eng",
      "question": "How long do we retain checkpoints?",
      "note": "Confluence policy says 30 days; a newer JIRA decision says 14. Synthesis must caveat.",
      "expect": [
        { "source": "confluence", "sourceIdPrefix": "HEL-014" },
        { "source": "jira", "sourceIdPrefix": "HEL-611" } ] },
    { "id": "who-shard-cache", "project": "helios-eng",
      "question": "Who has expertise on the shard cache?",
      "expectPeople": ["Priya Natarajan"] },
    { "id": "exact-error", "project": "helios-eng",
      "question": "What does ERR_MANIFEST_TIMEOUT mean and how do I fix it?",
      "expect": [ { "source": "jira", "sourceIdPrefix": "HEL-530" } ] },
    { "id": "paraphrase-serving", "project": "helios-eng",
      "question": "The model server refuses to boot after I changed its settings",
      "note": "No shared vocabulary with the fixture, which says config validation aborts startup.",
      "expect": [ { "source": "confluence", "sourceIdPrefix": "HEL-007" } ] },
    { "id": "rare-flag", "project": "helios-eng",
      "question": "What is HELIOS_PREFETCH_DEPTH?",
      "expect": [ { "source": "jira", "sourceIdPrefix": "HEL-482" },
                  { "source": "github", "sourceIdPrefix": "src/config" } ] },
    { "id": "recency-deploy", "project": "helios-eng",
      "question": "What is the current deploy process for Helios?",
      "note": "Two pages answer this. HEL-020 (old, blue-green) vs HEL-021 (new, canary). Newer must rank first.",
      "expect": [ { "source": "confluence", "sourceIdPrefix": "HEL-021" } ] },
    { "id": "staging-access", "project": "helios-eng",
      "question": "How do I get access to the Helios staging cluster?",
      "expect": [ { "source": "confluence", "sourceIdPrefix": "HEL-003" } ] },
    { "id": "checksum-code", "project": "helios-eng",
      "question": "Where is the manifest checksum validated?",
      "expect": [ { "source": "github", "sourceIdPrefix": "src/checkpoint/manifest.ts" } ] },
    { "id": "content-pricing", "project": "content",
      "question": "What does the launch draft say about pricing?",
      "expect": [ { "source": "bucket", "sourceIdPrefix": "launch-pricing-draft.md" } ] }
  ]
}
```

- [ ] **Step 3: Write the four exemplar fixtures**

`fixtures/confluence/HEL-001.json`:
```json
{
  "id": "HEL-001",
  "title": "Runbook: Checkpoint Restore Stalls",
  "space": "HELIOS",
  "authors": ["Priya Natarajan"],
  "updatedAt": "2026-06-14T09:00:00Z",
  "labels": ["runbook", "checkpoint", "storage"],
  "bodyMarkdown": "When a restore appears frozen, confirm whether it stalled after manifest load before escalating.\n\n## Symptoms\nRestore logs stop after the line manifest loaded. Small runs complete; clusters above 64 shards stall. CPU on the loader host drops to idle.\n\n## Diagnosis\nCheck the prefetch depth in effect. The loader in src/checkpoint/loader.ts reads HELIOS_PREFETCH_DEPTH and defaults to 16, which overwhelms NFS mounts.\n\n## Fix\nSet HELIOS_PREFETCH_DEPTH=4 on the loader hosts and restart the restore. See HEL-482 for the original incident.\n\n## Escalation\nPage the storage on-call if the stall persists past 15 minutes. Priya Natarajan owns this runbook."
}
```

`fixtures/jira/HEL-482.json`:
```json
{
  "key": "HEL-482",
  "summary": "Checkpoint restore stalls after manifest load on 128-shard clusters",
  "type": "Incident",
  "status": "Resolved",
  "components": ["checkpoint", "storage"],
  "createdAt": "2026-05-02T16:14:00Z",
  "resolvedAt": "2026-05-03T11:20:00Z",
  "reporter": "Maya Okafor",
  "description": "Restore of the 128-shard training checkpoint hangs indefinitely after the manifest loads. Small runs are unaffected. No errors in the loader logs.",
  "comments": [
    { "author": "Owen Reyes", "at": "2026-05-02T16:40:00Z", "body": "Reproduced on staging with 128 shards. Logs stop right before cache warmup. Attaching loader traces." },
    { "author": "Sam Whitfield", "at": "2026-05-02T16:41:00Z", "body": "my laptop also hangs when it sees monday" },
    { "author": "Priya Natarajan", "at": "2026-05-03T10:55:00Z", "body": "Root cause: the default prefetch depth of 16 in src/checkpoint/loader.ts saturates the NFS mount. Setting HELIOS_PREFETCH_DEPTH=4 lets the restore complete. The default is tuned for local SSD, not network storage. Long term we should auto-detect mount type and pick a depth, filed as follow-up." },
    { "author": "Maya Okafor", "at": "2026-05-03T11:18:00Z", "body": "Confirmed fixed with depth 4. Updating the runbook." }
  ]
}
```

`fixtures/bucket/launch-pricing-draft.md`:
```markdown
---
title: Helios Launch Announcement (Draft)
author: Gabe Rojas
date: 2026-06-20
type: draft
tags: [launch, pricing]
---

# Helios Launch Announcement

Draft copy for the public launch post.

## Pricing

Helios launches with two tiers. Serve is usage-based at $0.40 per million tokens with no minimum. Dedicated is capacity-based, starting at $4,800 per month per replica with a 12-month commitment. Early design partners keep their pilot pricing for six months after GA.
```

`fixtures/github/helios/src/checkpoint/loader.ts` (the file the incident and runbook point at):
```ts
import { Manifest, parseManifest, validateShards } from "./manifest.js";
import { ShardCache } from "./shardCache.js";
import { readFileBytes } from "../fs/reader.js";
import { config } from "../config/env.js";

export class CheckpointLoader {
  private manifest?: Manifest;
  constructor(private cache: ShardCache) {}

  async loadManifest(path: string): Promise<Manifest> {
    const bytes = await readFileBytes(path);
    this.manifest = parseManifest(bytes);
    validateShards(this.manifest);
    return this.manifest;
  }

  /**
   * Warm the shard cache ahead of restore. Prefetch depth is read from
   * HELIOS_PREFETCH_DEPTH; the default of 16 assumes local SSD and will
   * saturate an NFS mount. Network storage wants 4 or lower.
   */
  async warmShardCache(): Promise<void> {
    if (!this.manifest) throw new Error("manifest not loaded");
    const depth = config.prefetchDepth;
    const pending: Promise<void>[] = [];
    for (const shard of this.manifest.shards) {
      pending.push(this.cache.pin(shard.key));
      if (pending.length >= depth) {
        await Promise.race(pending);
        pending.splice(0, 1);
      }
    }
    await Promise.all(pending);
  }
}
```

`fixtures/github/helios/src/checkpoint/manifest.ts`:
```ts
import { createHash } from "node:crypto";

export interface Shard { key: string; bytes: number; checksum: string }
export interface Manifest { version: number; shards: Shard[]; checksum: string }

export function parseManifest(bytes: Buffer): Manifest {
  const parsed = JSON.parse(bytes.toString("utf8")) as Manifest;
  if (!Array.isArray(parsed.shards)) throw new Error("manifest has no shards");
  return parsed;
}

/** Manifest checksum validation lives here and nowhere else. */
export function validateShards(manifest: Manifest): void {
  const digest = createHash("sha256")
    .update(manifest.shards.map(s => s.checksum).join(""))
    .digest("hex");
  if (digest !== manifest.checksum)
    throw new Error(`ERR_MANIFEST_CHECKSUM: expected ${manifest.checksum}, got ${digest}`);
}
```

- [ ] **Step 4: Write the fixture lint test**

`packages/core/test/fixtures.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const fx = (p: string) => join(ROOT, "fixtures", p);
const CAST = new Set(["Maya Okafor", "Priya Natarajan", "Owen Reyes",
  "Sam Whitfield", "Jonah Kim", "Elena Petrova", "Gabe Rojas"]);

const loadDir = (dir: string) =>
  readdirSync(fx(dir)).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(fx(join(dir, f)), "utf8")));

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

describe("fixture lint", () => {
  const pages = loadDir("confluence");
  const issues = loadDir("jira");
  const codeFiles = walk(fx("github/helios")).filter(f => f.endsWith(".ts"));
  const bucketFiles = readdirSync(fx("bucket")).filter(f => f.endsWith(".md"));

  it("meets corpus minimums", () => {
    expect(pages.length).toBeGreaterThanOrEqual(20);
    expect(issues.length).toBeGreaterThanOrEqual(30);
    expect(codeFiles.length).toBeGreaterThanOrEqual(20);
    expect(bucketFiles.length).toBeGreaterThanOrEqual(8);
  });

  it("pages are well formed with known authors", () => {
    for (const p of pages) {
      for (const k of ["id", "title", "space", "authors", "updatedAt", "bodyMarkdown"])
        expect(p[k], `${p.id} missing ${k}`).toBeDefined();
      for (const a of p.authors) expect(CAST.has(a), `${p.id} unknown author ${a}`).toBe(true);
    }
  });

  it("issues are well formed with known authors", () => {
    for (const i of issues) {
      for (const k of ["key", "summary", "type", "status", "createdAt", "reporter", "description", "comments"])
        expect(i[k], `${i.key} missing ${k}`).toBeDefined();
      expect(CAST.has(i.reporter), `${i.key} unknown reporter`).toBe(true);
      for (const c of i.comments) expect(CAST.has(c.author), `${i.key} unknown ${c.author}`).toBe(true);
    }
  });

  it("every src/ path mentioned in prose exists in the code fixture", () => {
    const bodies = [
      ...pages.map((p: { bodyMarkdown: string }) => p.bodyMarkdown),
      ...issues.flatMap((i: { description: string; comments: { body: string }[] }) =>
        [i.description, ...i.comments.map(c => c.body)]),
    ].join("\n");
    for (const m of bodies.matchAll(/src\/[\w/.-]+\.ts/g))
      expect(existsSync(fx(join("github/helios", m[0]))), `${m[0]} missing`).toBe(true);
  });

  it("golden expectations all resolve to fixtures", () => {
    const golden = JSON.parse(readFileSync(join(ROOT, "eval/golden.json"), "utf8"));
    const pageIds = new Set(pages.map((p: { id: string }) => p.id));
    const issueKeys = new Set(issues.map((i: { key: string }) => i.key));
    expect(golden.questions.length).toBeGreaterThanOrEqual(10);
    for (const q of golden.questions) {
      for (const e of q.expect ?? []) {
        if (e.source === "confluence") expect(pageIds.has(e.sourceIdPrefix), `${q.id}`).toBe(true);
        if (e.source === "jira") expect(issueKeys.has(e.sourceIdPrefix), `${q.id}`).toBe(true);
        if (e.source === "github")
          expect(codeFiles.some(f => f.includes(e.sourceIdPrefix.replace("src/", ""))), `${q.id}: ${e.sourceIdPrefix}`).toBe(true);
        if (e.source === "bucket") expect(bucketFiles, `${q.id}`).toContain(e.sourceIdPrefix);
      }
    }
  });
});
```

- [ ] **Step 5: Run the lint test, expect a specific failure**

Run: `pnpm vitest run packages/core/test/fixtures.test.ts`
Expected: FAIL on corpus minimums (only 1 page, 1 issue, 2 code files, 1 bucket doc exist). Well-formedness and golden-resolution tests fail too because HEL-014, HEL-611, HEL-530, HEL-007, HEL-021, HEL-003 do not exist yet. That failure list is Task 8's to-do list.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Pin fixture shapes and golden questions so the corpus is authored against a contract"
```

---

### Task 8: Author the full fixture corpus until lint passes

**Files:**
- Create: ~19 more files in `fixtures/confluence/`, ~29 more in `fixtures/jira/`, ~18 more in `fixtures/github/helios/src/`, ~7 more in `fixtures/bucket/`

No new code. This is writing, done to the contract Task 7 pinned. Work through the lint failures in order.

- [ ] **Step 1: Author the code fixture (~18 more files)**

The Helios codebase under `fixtures/github/helios/src/`, each file 40 to 120 lines of real, coherent TypeScript that compiles in your head (it is never built). Required files, because prose references them: `checkpoint/shardCache.ts`, `config/env.ts` (reads `HELIOS_PREFETCH_DEPTH`, default 16, with a comment on SSD vs NFS), `fs/reader.ts`. Then fill out the system: `serving/server.ts`, `serving/configValidate.ts` (aborts startup on invalid settings), `serving/router.ts`, `api/http.ts`, `api/auth.ts`, `restore/coordinator.ts`, `restore/fetcher.ts` (throws `ERR_MANIFEST_TIMEOUT` when a manifest fetch exceeds its deadline), `metrics/stats.ts`, `metrics/exporter.ts`, `cli/main.ts`, `cli/flags.ts`, `util/backoff.ts`, `util/log.ts`, `types/core.ts`. Keep the same idioms as the two exemplar files.

- [ ] **Step 2: Author the Confluence corpus (~19 more pages)**

IDs HEL-002 through HEL-025, JSON shape identical to the exemplar. Required by golden questions: HEL-003 (staging cluster access, onboarding), HEL-007 (serving config validation aborts startup; deliberately avoid the words boot, refuses, settings), HEL-014 (checkpoint retention policy: 30 days, dated 2025-11), HEL-020 (deploy process, blue-green, dated 2025-09), HEL-021 (deploy process, canary, dated 2026-06, must state it replaces the old process). The rest: architecture overview, RFCs (auto depth detection referencing HEL-482, shard cache design by Priya Natarajan), runbooks (NFS mounts, serving rollbacks by Elena Petrova), onboarding (dev setup, oncall guide), team norms. Spread `updatedAt` across 18 months. Every page: 150 to 400 words of `bodyMarkdown` with `##` sections, at least two pages referencing real `src/` paths.

- [ ] **Step 3: Author the JIRA corpus (~29 more issues)**

Keys spread HEL-100 to HEL-650, shape identical to the exemplar. Required: HEL-530 (bug: `ERR_MANIFEST_TIMEOUT` in `src/restore/fetcher.ts`, resolution raises the deadline and points at slow object storage), HEL-611 (decision: cut checkpoint retention to 14 days for cost, dated 2026-05, later than HEL-014, resolution states it supersedes the wiki). Mix: ~8 incidents, ~10 bugs, ~8 features, ~3 decisions. Each has 2 to 6 comments in cast voices, most resolved with a substantive resolution comment; 3 to 5 issues left unresolved. Include one low-signal ack-only comment (like Sam's) in at least five threads so burst filtering has something to filter. Priya answers storage and shard cache threads; Owen serving; Elena SRE; Jonah compiler. Dates across 18 months.

- [ ] **Step 4: Author the bucket corpus (~7 more docs)**

Markdown with front matter like the exemplar, 7 synthetic docs total: a postmortem draft about the HEL-482 incident, a positioning one-pager, an internal FAQ draft, a second postmortem, a changelog narrative, launch talking points, and style notes. Production Notes posts are real content Gabe supplies separately; when he drops them into `fixtures/bucket/production-notes/`, they join the corpus on the next ingest with no code change. The synthetic docs exist so the content project stands alone until then.

- [ ] **Step 5: Run lint until green**

Run: `pnpm vitest run packages/core/test/fixtures.test.ts`
Expected: PASS (5 tests). Fix whatever it names until it does.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Author the interlocked Helios corpus the golden questions are graded against"
```

---

### Task 9: Bucket and Confluence connectors

**Files:**
- Create: `packages/core/src/ingest/frontmatter.ts`, `packages/core/src/ingest/connectors/bucket.ts`, `packages/core/src/ingest/connectors/confluence.ts`
- Test: `packages/core/test/connectors-docs.test.ts`
- Modify: `packages/core/src/index.ts` (add `export { bucketConnector } from "./ingest/connectors/bucket.js"; export { confluenceConnector } from "./ingest/connectors/confluence.js";`)

**Interfaces:**
- Consumes: `Connector`, `RawItem`, `DistilledDoc`, `DistillCtx` from Task 2; `splitMarkdownSections` from Task 6.
- Produces: `bucketConnector(dir: string): Connector` and `confluenceConnector(dir: string): Connector`. Both emit one `DistilledDoc` per section, `sourceId` = `<fileOrPageId>#<sectionIndex>`, `metadata` carries `{ authors, url, labels, sectionIndex, sectionCount, distilled }`. On LLM absence or failure the doc still emits with raw section text and `distilled: false`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/connectors-docs.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { bucketConnector } from "../src/ingest/connectors/bucket.js";
import { confluenceConnector } from "../src/ingest/connectors/confluence.js";
import type { DistillCtx, RawItem } from "../src/schema/types.js";

const ROOT = join(import.meta.dirname, "../../..");
const noop = () => {};
const mockLLM: DistillCtx = {
  model: "test",
  log: noop,
  llm: async () => JSON.stringify({ summary: "a summary", key_facts: ["fact one"] }),
};
const brokenLLM: DistillCtx = {
  model: "test", log: noop,
  llm: async () => { throw new Error("down"); },
};

async function firstItem(c: { discover(): AsyncIterable<RawItem> }): Promise<RawItem> {
  for await (const item of c.discover()) return item;
  throw new Error("no items");
}

describe("bucket connector", () => {
  const c = bucketConnector(join(ROOT, "fixtures/bucket"));
  it("discovers markdown with front matter metadata", async () => {
    const item = await firstItem(c);
    expect(item.sourceId).toMatch(/\.md$/);
    expect(item.title.length).toBeGreaterThan(0);
  });
  it("distills one doc per section with normalized content", async () => {
    const item = await firstItem(c);
    const docs = await c.distill(item, mockLLM);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0].source).toBe("bucket");
    expect(docs[0].sourceId).toBe(`${item.sourceId}#0`);
    expect(docs[0].content).toContain("a summary");
    expect(docs[0].metadata.distilled).toBe(true);
  });
  it("degrades to raw text when the LLM fails", async () => {
    const item = await firstItem(c);
    const docs = await c.distill(item, brokenLLM);
    expect(docs[0].metadata.distilled).toBe(false);
    expect(docs[0].content.length).toBeGreaterThan(0);
  });
});

describe("confluence connector", () => {
  const c = confluenceConnector(join(ROOT, "fixtures/confluence"));
  it("prepends the page title to section content", async () => {
    const item = await firstItem(c);
    const docs = await c.distill(item, mockLLM);
    expect(docs[0].title).toContain(item.title);
    expect(docs[0].content.startsWith(item.title)).toBe(true);
    expect(docs[0].metadata.sectionCount).toBe(docs.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/connectors-docs.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement front matter parser and both connectors**

`packages/core/src/ingest/frontmatter.ts`:
```ts
export function parseFrontMatter(md: string): {
  meta: Record<string, string | string[]>; body: string;
} {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string | string[]> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const val = kv[2].trim();
    meta[kv[1]] = val.startsWith("[")
      ? val.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean)
      : val;
  }
  return { meta, body: md.slice(m[0].length) };
}
```

`packages/core/src/ingest/connectors/bucket.ts`:
```ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Connector, DistillCtx, DistilledDoc, RawItem } from "../../schema/types.js";
import { splitMarkdownSections } from "../chunk.js";
import { parseFrontMatter } from "../frontmatter.js";

const DISTILL_SYSTEM = `You distill internal documents for a search index.
Given a document section, reply with ONLY JSON: {"summary": "...", "key_facts": ["..."]}.
The summary is 1 to 2 sentences an engineer would search for. Key facts are the 1 to 4
concrete claims in the section: numbers, names, decisions, commands. No prose outside JSON.`;

function walkMd(dir: string, base: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walkMd(join(dir, e.name), base)
      : e.name.endsWith(".md") ? [relative(base, join(dir, e.name))] : []);
}

async function distillSection(
  ctx: DistillCtx, heading: string | null, body: string
): Promise<{ text: string; distilled: boolean }> {
  const rawText = [heading, body].filter(Boolean).join("\n");
  if (!ctx.llm) return { text: rawText, distilled: false };
  try {
    const reply = await ctx.llm({
      model: ctx.model, system: DISTILL_SYSTEM,
      user: `<section heading="${heading ?? "none"}">\n${body}\n</section>`,
    });
    const parsed = JSON.parse(reply.replace(/```(?:json)?|```/g, "").trim()) as
      { summary: string; key_facts?: string[] };
    const text = [parsed.summary, ...(parsed.key_facts ?? [])].join("\n");
    return text.trim() ? { text, distilled: true } : { text: rawText, distilled: false };
  } catch (e) {
    ctx.log(`distill failed, degrading to raw text: ${e}`);
    return { text: rawText, distilled: false };
  }
}

export { distillSection };

export function bucketConnector(dir: string): Connector {
  return {
    source: "bucket",
    async *discover(): AsyncIterable<RawItem> {
      for (const rel of walkMd(dir, dir).sort()) {
        const { meta, body } = parseFrontMatter(readFileSync(join(dir, rel), "utf8"));
        yield {
          sourceId: rel,
          title: typeof meta.title === "string" ? meta.title : rel,
          payload: { meta, body },
          authoredAt: typeof meta.date === "string" ? new Date(meta.date) : undefined,
        };
      }
    },
    async distill(item, ctx): Promise<DistilledDoc[]> {
      const { meta, body } = item.payload as
        { meta: Record<string, string | string[]>; body: string };
      const sections = splitMarkdownSections(body);
      const out: DistilledDoc[] = [];
      for (const s of sections) {
        const d = await distillSection(ctx, s.heading, s.body);
        out.push({
          source: "bucket",
          sourceId: `${item.sourceId}#${s.index}`,
          kind: "doc_section",
          title: [item.title, s.heading].filter(Boolean).join(" / "),
          content: `${item.title}\n${d.text}`,
          raw: { heading: s.heading, body: s.body },
          metadata: {
            authors: [meta.author ?? "unknown"].flat(),
            url: `bucket://${item.sourceId}`,
            labels: [meta.tags ?? []].flat(),
            sectionIndex: s.index, sectionCount: sections.length,
            distilled: d.distilled,
          },
          authoredAt: item.authoredAt ?? null,
        });
      }
      return out;
    },
  };
}
```

`packages/core/src/ingest/connectors/confluence.ts`:
```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Connector, DistilledDoc, RawItem } from "../../schema/types.js";
import { splitMarkdownSections } from "../chunk.js";
import { distillSection } from "./bucket.js";

interface Page {
  id: string; title: string; space: string; authors: string[];
  updatedAt: string; labels?: string[]; bodyMarkdown: string;
}

export function confluenceConnector(dir: string): Connector {
  return {
    source: "confluence",
    async *discover(): AsyncIterable<RawItem> {
      for (const f of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
        const page = JSON.parse(readFileSync(join(dir, f), "utf8")) as Page;
        yield {
          sourceId: page.id, title: page.title, payload: page,
          authoredAt: new Date(page.updatedAt),
        };
      }
    },
    async distill(item, ctx): Promise<DistilledDoc[]> {
      const page = item.payload as Page;
      const sections = splitMarkdownSections(page.bodyMarkdown);
      const out: DistilledDoc[] = [];
      for (const s of sections) {
        const d = await distillSection(ctx, s.heading, s.body);
        out.push({
          source: "confluence",
          sourceId: `${page.id}#${s.index}`,
          kind: "page_section",
          title: [page.title, s.heading].filter(Boolean).join(" / "),
          content: `${page.title}\n${d.text}`,
          raw: { heading: s.heading, body: s.body },
          metadata: {
            authors: page.authors, url: `confluence://${page.space}/${page.id}`,
            labels: page.labels ?? [],
            sectionIndex: s.index, sectionCount: sections.length,
            distilled: d.distilled,
          },
          authoredAt: new Date(page.updatedAt),
        });
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/connectors-docs.test.ts`
Expected: PASS (5 tests). Front matter is stripped before sectioning, so the exemplar bucket doc's first section is index 0 under its `#` title heading.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add doc connectors that embed the distilled artifact, never the transcript"
```

---

### Task 10: GitHub and JIRA connectors

**Files:**
- Create: `packages/core/src/ingest/connectors/github.ts`, `packages/core/src/ingest/connectors/jira.ts`, `packages/core/src/ingest/burst.ts`
- Test: `packages/core/test/connectors-code-jira.test.ts`
- Modify: `packages/core/src/index.ts` (add `export { githubConnector } from "./ingest/connectors/github.js"; export { jiraConnector } from "./ingest/connectors/jira.js"; export { groupBursts, scoreBurst } from "./ingest/burst.js";`)

**Interfaces:**
- Consumes: `chunkTypeScript` (Task 6), `tokenize` (Task 5), `Connector` types (Task 2).
- Produces: `githubConnector(dir: string, repo: string): Connector` (LLM-free, one `code_chunk` doc per chunk, `sourceId` = `<relPath>#<startLine>-<endLine>`); `jiraConnector(dir: string, idf: Map<string, number>): Connector` (one `issue_thread` doc per issue plus qualifying `comment_burst` docs); `groupBursts(comments: { author: string; at: string; body: string }[]): Burst[]`; `scoreBurst(b: Burst, idf: Map<string, number>): { pass: boolean; reasons: string[] }` with thresholds maxIdf >= 4.0 and length >= 200.

- [ ] **Step 1: Write the failing test**

`packages/core/test/connectors-code-jira.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { githubConnector } from "../src/ingest/connectors/github.js";
import { jiraConnector } from "../src/ingest/connectors/jira.js";
import { groupBursts, scoreBurst } from "../src/ingest/burst.js";
import type { DistillCtx } from "../src/schema/types.js";

const ROOT = join(import.meta.dirname, "../../..");
const noop = () => {};
const threadJSON = JSON.stringify({
  question: "Why does restore stall after manifest load?",
  summary: "Prefetch depth 16 saturates NFS.",
  resolution: "Set HELIOS_PREFETCH_DEPTH=4.",
  systems: ["checkpoint", "NFS"], code_refs: ["src/checkpoint/loader.ts"],
});
const mockLLM: DistillCtx = { model: "t", log: noop, llm: async () => threadJSON };

describe("github connector", () => {
  const c = githubConnector(join(ROOT, "fixtures/github/helios"), "helios");
  it("emits code chunks with path-anchored ids and no LLM", async () => {
    for await (const item of c.discover()) {
      const docs = await c.distill(item, { model: "t", log: noop });
      expect(docs.length).toBeGreaterThan(0);
      expect(docs[0].kind).toBe("code_chunk");
      expect(docs[0].sourceId).toMatch(/^src\/.+#\d+-\d+$/);
      expect(docs[0].content).toContain("File: ");
      return;
    }
  });
});

describe("bursts", () => {
  const comments = [
    { author: "A", at: "2026-01-01T10:00:00Z", body: "short ack" },
    { author: "B", at: "2026-01-01T10:05:00Z", body: "x".repeat(150) },
    { author: "B", at: "2026-01-01T10:06:00Z", body: "the ckpt_prefetch flag controls parallel shard fetches and " + "y".repeat(160) },
    { author: "A", at: "2026-01-01T10:10:00Z", body: "thanks!" },
  ];
  it("groups consecutive same-author runs", () => {
    const bursts = groupBursts(comments);
    expect(bursts.map(b => b.author)).toEqual(["A", "B", "A"]);
    expect(bursts[1].bodies).toHaveLength(2);
  });
  it("passes only long bursts containing a rare token", () => {
    const idf = new Map([["ckpt_prefetch", 5.1]]);
    const [a, b, a2] = groupBursts(comments);
    expect(scoreBurst(b, idf).pass).toBe(true);
    expect(scoreBurst(a, idf).pass).toBe(false);
    expect(scoreBurst(a2, idf).pass).toBe(false);
  });
});

describe("jira connector", () => {
  it("emits one thread doc plus qualifying bursts", async () => {
    const idf = new Map([["prefetch", 4.5], ["nfs", 4.2]]);
    const c = jiraConnector(join(ROOT, "fixtures/jira"), idf);
    for await (const item of c.discover()) {
      if (item.sourceId !== "HEL-482") continue;
      const docs = await c.distill(item, mockLLM);
      const thread = docs.find(d => d.kind === "issue_thread")!;
      expect(thread.sourceId).toBe("HEL-482");
      expect(thread.content).toContain("Why does restore stall");
      expect(thread.content).toContain("HELIOS_PREFETCH_DEPTH=4");
      expect(thread.metadata.code_refs).toContain("src/checkpoint/loader.ts");
      const bursts = docs.filter(d => d.kind === "comment_burst");
      for (const b of bursts) expect(b.content).toContain(item.title);
      return;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/connectors-code-jira.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement bursts, then both connectors**

`packages/core/src/ingest/burst.ts`:
```ts
import { tokenize } from "./idf.js";

export interface Burst {
  author: string; at: string; bodies: string[];
}

export function groupBursts(
  comments: { author: string; at: string; body: string }[]
): Burst[] {
  const out: Burst[] = [];
  for (const c of comments) {
    const last = out[out.length - 1];
    if (last && last.author === c.author) last.bodies.push(c.body);
    else out.push({ author: c.author, at: c.at, bodies: [c.body] });
  }
  return out;
}

export function scoreBurst(
  b: Burst, idf: Map<string, number>
): { pass: boolean; reasons: string[] } {
  const text = b.bodies.join("\n");
  const reasons: string[] = [];
  if (text.length < 200) reasons.push(`length ${text.length} < 200`);
  const top = Math.max(0, ...tokenize(text).map(t => idf.get(t) ?? 0));
  if (top < 4.0) reasons.push(`max idf ${top.toFixed(2)} < 4.0`);
  return { pass: reasons.length === 0, reasons };
}
```

`packages/core/src/ingest/connectors/github.ts`:
```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Connector, DistilledDoc, RawItem } from "../../schema/types.js";
import { chunkTypeScript } from "../chunk.js";

function walkTs(dir: string, base: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walkTs(join(dir, e.name), base)
      : e.name.endsWith(".ts") ? [relative(base, join(dir, e.name))] : []);
}

export function githubConnector(dir: string, repo: string): Connector {
  return {
    source: "github",
    async *discover(): AsyncIterable<RawItem> {
      for (const rel of walkTs(dir, dir).sort()) {
        yield {
          sourceId: rel, title: rel,
          payload: readFileSync(join(dir, rel), "utf8"),
          authoredAt: statSync(join(dir, rel)).mtime,
        };
      }
    },
    async distill(item): Promise<DistilledDoc[]> {
      const code = item.payload as string;
      return chunkTypeScript(code).map(c => ({
        source: "github",
        sourceId: `${item.sourceId}#${c.startLine}-${c.endLine}`,
        kind: "code_chunk" as const,
        title: `${item.sourceId}:${c.startLine}`,
        content: `File: ${item.sourceId} (${repo})\n${c.text}`,
        raw: { startLine: c.startLine, endLine: c.endLine, boundary: c.boundary },
        metadata: {
          authors: [], url: `github://${repo}/${item.sourceId}#L${c.startLine}`,
          path: item.sourceId, boundary: c.boundary, distilled: false,
        },
        authoredAt: item.authoredAt ?? null,
      }));
    },
  };
}
```

`packages/core/src/ingest/connectors/jira.ts`:
```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Connector, DistillCtx, DistilledDoc, RawItem } from "../../schema/types.js";
import { groupBursts, scoreBurst } from "../burst.js";

interface Issue {
  key: string; summary: string; type: string; status: string;
  components?: string[]; createdAt: string; resolvedAt?: string;
  reporter: string; description: string;
  comments: { author: string; at: string; body: string }[];
}

const THREAD_SYSTEM = `You distill an issue tracker thread for a search index.
Reply with ONLY JSON:
{"question": "one line an engineer would search for",
 "summary": "1 to 2 sentences",
 "resolution": "how it was resolved, or empty string if unresolved",
 "systems": ["subsystem names"], "code_refs": ["file paths or flags mentioned"]}`;

function threadTranscript(issue: Issue): string {
  return [
    `[${issue.reporter}] ${issue.description}`,
    ...issue.comments.map(c => `[${c.author}] ${c.body}`),
  ].join("\n");
}

export function jiraConnector(dir: string, idf: Map<string, number>): Connector {
  return {
    source: "jira",
    async *discover(): AsyncIterable<RawItem> {
      for (const f of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
        const issue = JSON.parse(readFileSync(join(dir, f), "utf8")) as Issue;
        yield {
          sourceId: issue.key, title: issue.summary, payload: issue,
          authoredAt: new Date(issue.resolvedAt ?? issue.createdAt),
        };
      }
    },
    async distill(item, ctx: DistillCtx): Promise<DistilledDoc[]> {
      const issue = item.payload as Issue;
      const participants = [...new Set([issue.reporter, ...issue.comments.map(c => c.author)])];
      const base = {
        source: "jira",
        authoredAt: item.authoredAt ?? null,
      };
      let content: string;
      let distilled = true;
      let codeRefs: string[] = [];
      let systems: string[] = [];
      if (ctx.llm) {
        try {
          const reply = await ctx.llm({
            model: ctx.model, system: THREAD_SYSTEM,
            user: `<thread issue="${issue.key}" title="${issue.summary}" status="${issue.status}">\n${threadTranscript(issue)}\n</thread>`,
          });
          const t = JSON.parse(reply.replace(/```(?:json)?|```/g, "").trim()) as {
            question: string; summary: string; resolution: string;
            systems?: string[]; code_refs?: string[];
          };
          codeRefs = t.code_refs ?? []; systems = t.systems ?? [];
          content = [issue.summary, t.question, t.summary, t.resolution,
            ...systems, ...codeRefs].filter(Boolean).join("\n");
        } catch (e) {
          ctx.log(`jira distill failed for ${issue.key}, degrading: ${e}`);
          distilled = false;
          content = `${issue.summary}\n${threadTranscript(issue)}`;
        }
      } else {
        distilled = false;
        content = `${issue.summary}\n${threadTranscript(issue)}`;
      }
      const docs: DistilledDoc[] = [{
        ...base, sourceId: issue.key, kind: "issue_thread",
        title: `${issue.key}: ${issue.summary}`, content,
        raw: issue,
        metadata: {
          authors: participants, url: `jira://${issue.key}`,
          status: issue.status, type: issue.type,
          components: issue.components ?? [],
          systems, code_refs: codeRefs, distilled,
        },
      }];
      groupBursts(issue.comments).forEach((b, i) => {
        const verdict = scoreBurst(b, idf);
        if (!verdict.pass) {
          ctx.log(`burst ${issue.key}#b${i} filtered: ${verdict.reasons.join("; ")}`);
          return;
        }
        docs.push({
          ...base, sourceId: `${issue.key}#b${i}`, kind: "comment_burst",
          title: `${issue.key} comment by ${b.author}`,
          content: `${issue.summary}\n${b.bodies.join("\n")}`,
          raw: b,
          metadata: { authors: [b.author], url: `jira://${issue.key}`, distilled: false },
        });
      });
      return docs;
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/connectors-code-jira.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add code and thread connectors; bursts make buried answers findable"
```

---

### Task 11: Ingest orchestrator

**Files:**
- Create: `packages/core/src/ingest/run.ts`
- Test: `packages/core/test/ingest.test.ts`
- Modify: `packages/core/src/index.ts` (add `export { runIngest, defaultConnectors } from "./ingest/run.js";`)

**Interfaces:**
- Consumes: everything from Tasks 2 through 10.
- Produces: `runIngest(pool, opts: { fixturesDir: string; sources?: string[]; llm?: DistillCtx["llm"]; distillModel: string; log: (m: string) => void }): Promise<IngestSummary>` where `IngestSummary = { perSource: Record<string, { ingested: number; skipped: number; degraded: number; failed: number }>; tokens: number }`; `defaultConnectors(fixturesDir, idf): Connector[]`; helper `vectorLiteral(v: number[]): string`.

Design notes the implementer needs:
- JIRA burst filtering needs IDF before any DB rows exist. Bootstrap it in memory: before distilling, read every JIRA fixture's description and comment bodies, `computeIdf` over them, and hand that map to `jiraConnector`. Deterministic on a cold database.
- Idempotency: `content_hash = sha256(content)`. Load `(source_id, content_hash)` pairs per source up front; unchanged docs are skipped without embedding. Changed or new docs are embedded in one `embedDocs` batch per source, then upserted with `ON CONFLICT (source, source_id) DO UPDATE` setting `updated_at = now()`.
- Fault isolation is per item: one failing item increments `failed` and the run continues.
- After all sources: seed `sources` and `projects` from `fixtures/projects.json`, set `last_synced`, then `rebuildTokenIdf` and report its token count.

- [ ] **Step 1: Write the failing test**

`packages/core/test/ingest.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { getPool } from "../src/schema/db.js";
import { migrate } from "../src/schema/migrate.js";
import { runIngest } from "../src/ingest/run.js";

const ROOT = join(import.meta.dirname, "../../..");
const pool = getPool();
const mockLlm = async ({ system }: { system: string }) =>
  system.includes("issue tracker")
    ? JSON.stringify({ question: "q", summary: "s", resolution: "r", systems: [], code_refs: [] })
    : JSON.stringify({ summary: "distilled summary", key_facts: ["fact"] });

beforeAll(async () => {
  await migrate(pool);
  await pool.query(`TRUNCATE embeddings, token_idf, project_sources, projects, sources`);
}, 30_000);
afterAll(async () => { await pool.end(); });

describe("runIngest", () => {
  it("ingests the full fixture corpus", { timeout: 600_000 }, async () => {
    const s = await runIngest(pool, {
      fixturesDir: join(ROOT, "fixtures"), llm: mockLlm,
      distillModel: "test", log: () => {},
    });
    for (const src of ["confluence", "jira", "github", "bucket"]) {
      expect(s.perSource[src].ingested, src).toBeGreaterThan(0);
      expect(s.perSource[src].failed, src).toBe(0);
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM embeddings WHERE embedding IS NOT NULL`);
    expect(rows[0].n).toBeGreaterThan(100);
    const idf = await pool.query(`SELECT count(*)::int AS n FROM token_idf`);
    expect(idf.rows[0].n).toBeGreaterThan(200);
    const projects = await pool.query(`SELECT count(*)::int AS n FROM projects`);
    expect(projects.rows[0].n).toBe(2);
  });

  it("skips everything on a second run", { timeout: 600_000 }, async () => {
    const s = await runIngest(pool, {
      fixturesDir: join(ROOT, "fixtures"), llm: mockLlm,
      distillModel: "test", log: () => {},
    });
    for (const src of Object.keys(s.perSource)) {
      expect(s.perSource[src].ingested, src).toBe(0);
      expect(s.perSource[src].skipped, src).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/ingest.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/core/src/ingest/run.ts`:
```ts
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import type { Connector, DistillCtx } from "../schema/types.js";
import { embedDocs } from "../models/embeddings.js";
import { computeIdf, rebuildTokenIdf, tokenize } from "./idf.js";
import { bucketConnector } from "./connectors/bucket.js";
import { confluenceConnector } from "./connectors/confluence.js";
import { githubConnector } from "./connectors/github.js";
import { jiraConnector } from "./connectors/jira.js";

export interface IngestSummary {
  perSource: Record<string, { ingested: number; skipped: number; degraded: number; failed: number }>;
  tokens: number;
}

export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

function bootstrapJiraIdf(fixturesDir: string): Map<string, number> {
  const dir = join(fixturesDir, "jira");
  const docs: string[][] = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const issue = JSON.parse(readFileSync(join(dir, f), "utf8")) as
      { description: string; comments: { body: string }[] };
    docs.push(tokenize(issue.description));
    for (const c of issue.comments) docs.push(tokenize(c.body));
  }
  return new Map([...computeIdf(docs)].map(([t, s]) => [t, s.idf]));
}

export function defaultConnectors(
  fixturesDir: string, jiraIdf: Map<string, number>
): Connector[] {
  return [
    confluenceConnector(join(fixturesDir, "confluence")),
    jiraConnector(join(fixturesDir, "jira"), jiraIdf),
    githubConnector(join(fixturesDir, "github/helios"), "helios"),
    bucketConnector(join(fixturesDir, "bucket")),
  ];
}

export async function runIngest(pool: pg.Pool, opts: {
  fixturesDir: string; sources?: string[];
  llm?: DistillCtx["llm"]; distillModel: string;
  log: (m: string) => void;
}): Promise<IngestSummary> {
  const connectors = defaultConnectors(opts.fixturesDir, bootstrapJiraIdf(opts.fixturesDir))
    .filter(c => !opts.sources || opts.sources.includes(c.source));
  const summary: IngestSummary = { perSource: {}, tokens: 0 };

  for (const connector of connectors) {
    const stat = { ingested: 0, skipped: 0, degraded: 0, failed: 0 };
    summary.perSource[connector.source] = stat;
    const known = new Map<string, string>(
      (await pool.query(
        `SELECT source_id, content_hash FROM embeddings WHERE source = $1`,
        [connector.source]
      )).rows.map(r => [r.source_id, r.content_hash])
    );
    const ctx: DistillCtx = { llm: opts.llm, model: opts.distillModel, log: opts.log };
    const pending: { doc: Awaited<ReturnType<Connector["distill"]>>[number]; hash: string }[] = [];

    for await (const item of connector.discover()) {
      try {
        for (const doc of await connector.distill(item, ctx)) {
          const hash = createHash("sha256").update(doc.content).digest("hex");
          if (known.get(doc.sourceId) === hash) { stat.skipped++; continue; }
          if (doc.metadata.distilled === false && connector.source !== "github"
              && connector.source !== "jira") stat.degraded++;
          pending.push({ doc, hash });
        }
      } catch (e) {
        stat.failed++;
        opts.log(`item ${item.sourceId} failed: ${e}`);
      }
    }

    const vectors = await embedDocs(pending.map(p => p.doc.content));
    for (let i = 0; i < pending.length; i++) {
      const { doc, hash } = pending[i];
      await pool.query(
        `INSERT INTO embeddings
           (source, source_id, kind, title, content, raw, metadata, authored_at, content_hash, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (source, source_id) DO UPDATE SET
           kind=$3, title=$4, content=$5, raw=$6, metadata=$7, authored_at=$8,
           content_hash=$9, embedding=$10, updated_at=now()`,
        [doc.source, doc.sourceId, doc.kind, doc.title, doc.content,
         JSON.stringify(doc.raw), JSON.stringify(doc.metadata),
         doc.authoredAt, hash, vectorLiteral(vectors[i])]
      );
      stat.ingested++;
    }
    await pool.query(
      `INSERT INTO sources (name, last_synced) VALUES ($1, now())
       ON CONFLICT (name) DO UPDATE SET last_synced = now()`, [connector.source]);
    opts.log(`${connector.source}: ${stat.ingested} ingested, ${stat.skipped} skipped, ` +
      `${stat.degraded} degraded, ${stat.failed} failed`);
  }

  const projectsFile = JSON.parse(
    readFileSync(join(opts.fixturesDir, "projects.json"), "utf8")) as
    { projects: { name: string; description: string; sources: string[] }[] };
  for (const p of projectsFile.projects) {
    await pool.query(
      `INSERT INTO projects (name, description) VALUES ($1,$2)
       ON CONFLICT (name) DO UPDATE SET description=$2`, [p.name, p.description]);
    for (const s of p.sources) {
      await pool.query(
        `INSERT INTO sources (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [s]);
      await pool.query(
        `INSERT INTO project_sources (project, source) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`, [p.name, s]);
    }
  }
  summary.tokens = await rebuildTokenIdf(pool);
  return summary;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/ingest.test.ts`
Expected: PASS (2 tests). First run embeds the whole corpus locally; a few minutes on CPU is normal.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Orchestrate ingest with hash-skip and per-item isolation so re-runs are cheap and one bad doc never kills a sync"
```

---

### Task 12: CLI with `kb init` and `kb ingest`, live end to end

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/index.ts`
- Modify: root `package.json` (add script `"kb": "tsx packages/cli/src/index.ts"`)

**Interfaces:**
- Consumes: `loadConfig`, `getPool`, `migrate`, `runIngest`, `chat` from `@kb/core`.
- Produces: the `kb` command Plan 2 extends with `search` and `ask`.

- [ ] **Step 1: Write the CLI**

`packages/cli/package.json`:
```json
{
  "name": "@kb/cli",
  "version": "0.0.1",
  "type": "module",
  "dependencies": {
    "@kb/core": "workspace:*",
    "commander": "^13.0.0",
    "picocolors": "^1.1.0"
  }
}
```

`packages/cli/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

`packages/cli/src/index.ts`:
```ts
import { Command } from "commander";
import pc from "picocolors";
import { join } from "node:path";
import { chat, getPool, loadConfig, migrate, runIngest } from "@kb/core";

const FIXTURES = join(process.cwd(), "fixtures");
const program = new Command().name("kb").description("Anatomy of a knowledge base");

program.command("init").description("Run migrations and verify the stack").action(async () => {
  const pool = getPool();
  await migrate(pool);
  console.log(pc.green("✓ schema migrated"));
  const cfg = loadConfig();
  if (!cfg.cerebrasApiKey) {
    console.log(pc.yellow("! CEREBRAS_API_KEY not set: ingest will skip distillation"));
  } else {
    const reply = await chat({
      model: cfg.models.planner, system: "Reply with exactly: ok",
      user: "healthcheck", maxTokens: 10,
    });
    console.log(pc.green(`✓ cerebras reachable (${cfg.models.planner}: ${reply.trim()})`));
  }
  await pool.end();
});

program.command("ingest")
  .description("Ingest fixture sources into the embeddings table")
  .option("--source <name...>", "limit to specific sources")
  .option("--no-llm", "skip distillation even if a key is present")
  .action(async (opts: { source?: string[]; llm: boolean }) => {
    const cfg = loadConfig();
    const pool = getPool();
    await migrate(pool);
    const useLlm = opts.llm && Boolean(cfg.cerebrasApiKey);
    if (!useLlm) console.log(pc.yellow("running without distillation (degraded rows will say so)"));
    const started = Date.now();
    const summary = await runIngest(pool, {
      fixturesDir: FIXTURES,
      sources: opts.source,
      distillModel: cfg.models.distill,
      llm: useLlm
        ? (o) => chat({ model: o.model, system: o.system, user: o.user })
        : undefined,
      log: (m) => console.log(pc.dim(`  ${m}`)),
    });
    console.log(pc.bold("\nsource       ingested  skipped  degraded  failed"));
    for (const [src, s] of Object.entries(summary.perSource)) {
      console.log(
        `${src.padEnd(12)} ${String(s.ingested).padStart(8)} ${String(s.skipped).padStart(8)}` +
        ` ${String(s.degraded).padStart(9)} ${String(s.failed).padStart(7)}`);
    }
    console.log(pc.dim(`\n${summary.tokens} idf tokens, ${((Date.now() - started) / 1000).toFixed(1)}s`));
    await pool.end();
  });

await program.parseAsync();
```

- [ ] **Step 2: Install and run init**

Run: `pnpm install && pnpm kb init`
Expected: `✓ schema migrated` and `✓ cerebras reachable (gemma-4-31b: ok)`.

- [ ] **Step 3: Run the live ingest**

Run: `pnpm kb ingest`
Expected: the summary table with hundreds of ingested rows across four sources, `failed` all zero, `degraded` low single digits at most. This is the first full run with real distillation; expect minutes, and watch a couple of dim log lines for filtered bursts.

- [ ] **Step 4: Spot-check a distilled row**

Run: `podman exec -it $(podman ps -qf name=db) psql -U kb -d kb -c "SELECT source_id, left(content, 120) FROM embeddings WHERE source='jira' AND kind='issue_thread' AND source_id='HEL-482';"`
Expected: normalized question/summary/resolution text, not the raw transcript.

- [ ] **Step 5: Run the whole suite, then commit**

Run: `pnpm test`
Expected: all green.

```bash
git add -A && git commit -m "Ship kb init and kb ingest: the store is now real and inspectable"
```

---

## Done means

`podman compose up -d && pnpm install && pnpm kb init && pnpm kb ingest` on a fresh clone produces a populated embeddings table with distilled artifacts, passing the full test suite. Plan 2 builds retrieval on top of this store.
