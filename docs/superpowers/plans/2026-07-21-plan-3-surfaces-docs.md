# Plan 3 of 3: Surfaces and Docs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The MCP server, the web UI, the ten teaching docs with Mermaid diagrams, README, and license: everything needed to push a public repo that teaches.

**Architecture:** `packages/mcp` wraps the six existing tools in an LLM-free stdio MCP server. `packages/web` is a Hono API (SSE-streamed ask pipeline) serving a built Vite + React + Tailwind single page. Docs are numbered in pipeline order and pair every diagram with the source file it explains.

**Tech Stack:** additions only: `@modelcontextprotocol/sdk` ^1.29 (v1.x stable, NOT the 2.0 alpha packages), `zod` ^3, `hono` + `@hono/node-server`, `vite` + `@vitejs/plugin-react`, `tailwindcss` ^4 + `@tailwindcss/vite`, `react` ^19.

## Global Constraints

- No em dashes and no double dashes in any prose, docs, comments, or commit messages. CLI flags and YAML/TOML syntax in code blocks are code, not prose.
- ESM everywhere; `.js` extensions on relative imports.
- MCP tools are LLM-free: `buildTools` is constructed WITHOUT an llm option so `search` skips rerank. The client agent orchestrates; the server never calls Cerebras.
- Tests run against `kb_test` only (the guard enforces this); live smokes run against the live `kb` store explicitly.
- Docs must tell the truth about the demo's limits. Every simplification gets named in `docs/08-scaling.md`; every measured surprise (listed in Task 5) appears where it belongs.
- Mermaid in every docs page. GitHub renders it natively; no image binaries in the repo.
- Commit after every task. Commit messages explain why.

---

### Task 1: Code cleanups from the Plan 2 triage

**Files:**
- Modify: `packages/core/src/retrieval/expand.ts`, `packages/core/src/answer/ask.ts`, `packages/core/src/answer/tools.ts`, `eval/run.ts`
- Rename: `packages/core/test/zeval.test.ts` to `packages/core/test/golden.test.ts` (content unchanged)
- Test: extend `packages/core/test/tools.test.ts`, `packages/core/test/ask.test.ts`, `packages/core/test/rerank-expand.test.ts`

**Interfaces:** no signature changes; behavior tightens.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/rerank-expand.test.ts` inside the expandDoc describe:
```ts
it("refuses path traversal in code chunk metadata", async () => {
  const doc: RetrievedDoc = {
    id: 0, source: "github", sourceId: "../../.env#1-2", kind: "code_chunk",
    title: "evil", content: "original", metadata: { path: "../../.env" },
    authoredAt: null, score: 1,
  };
  const expanded = await expandDoc(pool, doc, { fixturesDir: join(ROOT, "fixtures") });
  expect(expanded).toBe("original");
});
```

Append to `packages/core/test/ask.test.ts` inside the ask describe:
```ts
it("dedupes evidence that two tools both return", async () => {
  const llm = async ({ system }: { system: string }) => {
    if (system.includes("select the best tools"))
      return JSON.stringify({ tools: [
        { name: "search_jira", query: "manifest timeout" },
        { name: "search_jira", query: "manifest timeout" }], reasoning: "twice" });
    return "answer [1]";
  };
  const result = await ask(pool, "what is ERR_MANIFEST_TIMEOUT?", {
    fixturesDir: join(ROOT, "fixtures"), llm,
  });
  const keys = result.evidence.map(e => `${e.source}:${e.sourceId}`);
  expect(new Set(keys).size).toBe(keys.length);
});
```

Append to `packages/core/test/tools.test.ts`:
```ts
it("search_code treats metacharacters literally unless re: prefix is used", async () => {
  const literal = await get("search_code").run({ query: "config.prefetchDepth" });
  expect(literal.length).toBeGreaterThan(0);
  const regex = await get("search_code").run({ query: "re:prefetch(Depth)?" });
  expect(regex.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm vitest run packages/core/test/rerank-expand.test.ts packages/core/test/ask.test.ts packages/core/test/tools.test.ts`
Expected: the three new tests fail (traversal returns file content today; duplicates survive; `config.prefetchDepth` as regex matches `configXprefetchDepth`-style lines only, so the literal test may pass by luck while the intent is unpinned; implement regardless).

- [ ] **Step 3: Implement the four tightenings**

1. `expand.ts` code_chunk branch: before reading, `const rel = (doc.metadata.path as string) ?? doc.sourceId.split("#")[0]; if (rel.includes("..")) return doc.content;`
2. `expand.ts` `neighborSections`: sort fetched rows by parsed numeric index, not lexicographically: fetch with the same query minus `ORDER BY source_id`, then sort in JS by `Number(source_id.split("#")[1])`.
3. `ask.ts`: after `settled.flat()`, dedupe keeping first occurrence: `const seen = new Set<string>(); const evidence = settled.flat().filter(e => { const k = `${e.source}:${e.sourceId}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20);`
4. `tools.ts` search_code: literal by default, regex only with `re:` prefix, and stop reading files once full:
```ts
const raw = query.startsWith("re:") ? query.slice(3) : null;
let re: RegExp;
if (raw !== null) {
  try { re = new RegExp(raw, "i"); }
  catch { re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
} else {
  re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}
```
and in the file loop: `if (out.length >= 50) break;` before each `readFileSync`.
5. `eval/run.ts`: replace the hardcoded `passed >= 8` with `passed >= questions.length - 2` (both places if the exit code and any message use it).
6. `git mv packages/core/test/zeval.test.ts packages/core/test/golden.test.ts` (ensureCorpus already makes it order-independent; the z-prefix was a vestige).
7. Update the `search_code` tool description to mention the `re:` prefix: `"Exact text search over the Helios codebase: flags, error strings, function names. Prefix with re: for regex."`

- [ ] **Step 4: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: all green (66 tests plus the three new ones).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Tighten the edges the whole-branch reviews named before the repo goes public"
```

---

### Task 2: MCP server

**Files:**
- Create: `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/src/index.ts`, `packages/mcp/src/server.ts`
- Test: `packages/mcp/test/server.test.ts`
- Modify: root `package.json` (script `"kb-mcp": "tsx packages/mcp/src/index.ts"`)

**Interfaces:**
- Consumes: `buildTools`, `getPool`, `loadConfig` from `@kb/core`.
- Produces: `createKbServer(pool, fixturesDir): McpServer` (exported for tests) and a stdio entry point. Six MCP tools mirroring `buildTools` exactly, LLM-free, each returning the JSON-serialized `EvidenceRow[]` as text content.

- [ ] **Step 1: Write the failing test**

`packages/mcp/test/server.test.ts`:
```ts
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
afterAll(async () => { await client.close(); await pool.end(); });

describe("kb mcp server", () => {
  it("lists exactly the six tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      "list_projects", "search", "search_code", "search_confluence",
      "search_jira", "who_knows"]);
  });

  it("search_code returns evidence rows as JSON text", async () => {
    const res = await client.callTool({
      name: "search_code", arguments: { query: "HELIOS_PREFETCH_DEPTH" } });
    const content = res.content as { type: string; text: string }[];
    expect(content[0].type).toBe("text");
    const rows = JSON.parse(content[0].text) as { sourceId: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].sourceId).toMatch(/^src\//);
  });

  it("who_knows works over the wire", async () => {
    const res = await client.callTool({
      name: "who_knows", arguments: { query: "shard cache" } });
    const rows = JSON.parse((res.content as { text: string }[])[0].text) as
      { sourceId: string }[];
    expect(rows.map(r => r.sourceId)).toContain("Priya Natarajan");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/mcp/test/server.test.ts`
Expected: FAIL, package and modules not found.

- [ ] **Step 3: Implement**

`packages/mcp/package.json`:
```json
{
  "name": "@kb/mcp",
  "version": "0.0.1",
  "type": "module",
  "dependencies": {
    "@kb/core": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.24.0"
  },
  "devDependencies": { "@types/node": "^22.0.0" }
}
```

`packages/mcp/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

`packages/mcp/src/server.ts`:
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type pg from "pg";
import { buildTools } from "@kb/core";

/**
 * Every tool here is LLM-free by design: buildTools gets no llm option, so
 * search runs retrieval through fusion and skips rerank. The MCP client
 * (Claude Code or any agent) is the orchestrator; this server only serves
 * evidence. That split is the point the blog makes about MCP.
 */
export function createKbServer(pool: pg.Pool, fixturesDir: string): McpServer {
  const server = new McpServer({ name: "anatomy-of-a-knowledge-base", version: "1.0.0" });
  for (const tool of buildTools(pool, { fixturesDir })) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: {
          query: z.string().describe("What to look for"),
          project: z.string().optional()
            .describe("Optional project scope: helios-eng or content"),
        },
      },
      async ({ query, project }) => {
        const rows = await tool.run({ query, project });
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      }
    );
  }
  return server;
}
```

`packages/mcp/src/index.ts`:
```ts
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getPool } from "@kb/core";
import { createKbServer } from "./server.js";

const server = createKbServer(getPool(), join(process.cwd(), "fixtures"));
await server.connect(new StdioServerTransport());
```

Run `pnpm install` after adding the package.

- [ ] **Step 4: Run tests, then a stdio smoke**

Run: `pnpm vitest run packages/mcp/test/server.test.ts`
Expected: PASS (3 tests).

Stdio smoke (uses the live store; read-only):
Run: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | pnpm kb-mcp 2>/dev/null | tail -1 | head -c 300`
Expected: a JSON reply listing the six tools.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Serve raw retrieval over MCP so the client agent owns orchestration"
```

---

### Task 3: askStream refactor and the web API

**Files:**
- Modify: `packages/core/src/answer/ask.ts` (extract `askStream`), `packages/core/src/index.ts` (export it)
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/src/api.ts`
- Test: `packages/core/test/ask.test.ts` (one new test), `packages/web/test/api.test.ts`

**Interfaces:**
- Produces in core: `askStream(pool, question, opts, emit: (e: AskStage) => void): Promise<AskResult>` where `AskStage = { stage: "plan"; plan: AskResult["plan"] } | { stage: "evidence"; tool: string; rows: EvidenceRow[] } | { stage: "answer"; text: string }`. `ask()` becomes a thin wrapper calling `askStream` with a no-op emit; behavior and return type unchanged.
- Produces in web: a Hono app (exported as `app` for tests) with `GET /api/search?q=&project=` returning `SearchResult` JSON, `GET /api/projects` returning the projects list, `GET /api/ask?q=&project=` streaming SSE events named `plan`, `evidence` (one per tool), `answer`, `done`, and static serving of `packages/web/dist` at `/`. Entry `pnpm web` serves on port 8787.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/ask.test.ts`:
```ts
it("askStream emits plan, per-tool evidence, then answer", async () => {
  const llm = async ({ system }: { system: string }) => {
    if (system.includes("select the best tools"))
      return JSON.stringify({ tools: [{ name: "search_jira", query: "manifest timeout" }],
        reasoning: "jira only" });
    return "streamed answer [1]";
  };
  const stages: string[] = [];
  const { askStream } = await import("../src/answer/ask.js");
  const result = await askStream(pool, "what is ERR_MANIFEST_TIMEOUT?", {
    fixturesDir: join(ROOT, "fixtures"), llm,
  }, (e) => stages.push(e.stage));
  expect(stages).toEqual(["plan", "evidence", "answer"]);
  expect(result.answer).toContain("streamed answer");
});
```

`packages/web/test/api.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@kb/core";
import { ensureCorpus } from "../../core/test/helpers.js";
import { app, closePool } from "../src/api.js";

beforeAll(async () => { await ensureCorpus(getPool()); }, 600_000);
afterAll(async () => { await closePool(); });

describe("web api", () => {
  it("GET /api/projects lists both projects", async () => {
    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    const rows = await res.json() as { sourceId: string }[];
    expect(rows.map(r => r.sourceId).sort()).toEqual(["content", "helios-eng"]);
  });

  it("GET /api/search returns evidence and trace", async () => {
    const res = await app.request("/api/search?q=checkpoint%20restore%20stalls");
    expect(res.status).toBe(200);
    const body = await res.json() as { evidence: unknown[]; trace: { lists: unknown[] } };
    expect(body.evidence.length).toBeGreaterThan(0);
    expect(body.trace.lists.length).toBeGreaterThanOrEqual(4);
  });

  it("GET /api/search without q is a 400", async () => {
    const res = await app.request("/api/search");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm vitest run packages/core/test/ask.test.ts packages/web/test/api.test.ts`
Expected: askStream import fails; web package missing.

- [ ] **Step 3: Implement**

Refactor `packages/core/src/answer/ask.ts`: rename the existing body to `askStream` with the emit parameter, emitting `{ stage: "plan", plan: p }` right after planning, `{ stage: "evidence", tool: t.name, rows }` per settled tool (emit inside the Promise.all map's then, so evidence streams as each tool finishes), and `{ stage: "answer", text: answer }` after synthesis. Keep the dedupe from Task 1 applied to the concatenated evidence AFTER emitting per-tool rows (the UI shows per-tool results; the synthesis bundle dedupes). `export async function ask(...)` calls `askStream(pool, question, opts, () => {})`.

`packages/web/package.json`:
```json
{
  "name": "@kb/web",
  "version": "0.0.1",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": {
    "@hono/node-server": "^1.13.0",
    "@kb/core": "workspace:*",
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tailwindcss": "^4.0.0",
    "vite": "^6.0.0"
  }
}
```

`packages/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist-server", "rootDir": "src",
    "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

`packages/web/src/api.ts`:
```ts
import { join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { askStream, buildTools, chat, getPool, loadConfig, search } from "@kb/core";

const pool = getPool();
const FIXTURES = join(process.cwd(), "fixtures");

const llm = (() => {
  const cfg = loadConfig();
  if (!cfg.cerebrasApiKey) return undefined;
  return async (o: { model: string; system: string; user: string }) => {
    await new Promise((r) => setTimeout(r, 400));
    return chat({ model: o.model, system: o.system, user: o.user, attempts: 5 });
  };
})();

export const app = new Hono();

app.get("/api/projects", async (c) => {
  const tools = buildTools(pool, { fixturesDir: FIXTURES });
  return c.json(await tools.find(t => t.name === "list_projects")!.run({ query: "" }));
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
  if (!llm) return c.json({ error: "CEREBRAS_API_KEY is not set; ask needs it" }, 503);
  const project = c.req.query("project") || undefined;
  return streamSSE(c, async (stream) => {
    try {
      await askStream(pool, q, { project, fixturesDir: FIXTURES, llm },
        (e) => void stream.writeSSE({ event: e.stage, data: JSON.stringify(e) }));
      await stream.writeSSE({ event: "done", data: "{}" });
    } catch (err) {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ message: String(err) }) });
    }
  });
});

app.use("/*", serveStatic({ root: "./packages/web/dist" }));

export async function closePool(): Promise<void> { await pool.end(); }

if (process.argv[1]?.endsWith("api.ts") || process.argv[1]?.endsWith("api.js")) {
  serve({ fetch: app.fetch, port: 8787 });
  console.log("kb web on http://localhost:8787");
}
```

Root `package.json` gains `"web": "tsx packages/web/src/api.ts"`. Run `pnpm install`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/ask.test.ts packages/web/test/api.test.ts && pnpm typecheck`
Expected: all pass (ask now 6 tests, api 3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Stream the ask pipeline over SSE so the UI can show each stage arriving"
```

---

### Task 4: The web UI

**Files:**
- Create: `packages/web/index.html`, `packages/web/vite.config.ts`, `packages/web/src/main.tsx`, `packages/web/src/App.tsx`, `packages/web/src/index.css`

**Interfaces:**
- Consumes: `/api/projects`, `/api/ask` SSE events (`plan`, `evidence`, `answer`, `done`, `error`).
- Produces: a single built page at `packages/web/dist` that the API server serves.

**Design constraints (binding, not suggestions):** one column, max width 720px, generous whitespace. System font stack for UI, monospace for source ids and code. Neutral background (`zinc` scale), ONE accent color used only for interactive elements and the answer citations (`indigo-600`, dark mode `indigo-400`). No gradients, no shadows heavier than `shadow-sm`, no border radius above `rounded-md`, no component library, no icons except unicode. Stage cards appear in arrival order with a 150ms ease-out fade; skeleton bars while waiting. Citations `[n]` in the answer are buttons that scroll to and flash the matching evidence row. Dark mode via `prefers-color-scheme` only. If a choice is not specified here, choose the quieter option.

- [ ] **Step 1: Write the shell and config**

`packages/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Anatomy of a Knowledge Base</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/web/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": "http://localhost:8787" } },
});
```

`packages/web/src/index.css`:
```css
@import "tailwindcss";

@keyframes rise {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.stage-enter { animation: rise 150ms ease-out; }
@keyframes flash {
  0% { background-color: rgb(99 102 241 / 0.15); }
  100% { background-color: transparent; }
}
.evidence-flash { animation: flash 1.2s ease-out; }
```

`packages/web/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>
);
```

- [ ] **Step 2: Write App.tsx**

`packages/web/src/App.tsx`: a single component file, roughly 220 lines, with this exact structure and state model:

```tsx
import { useEffect, useRef, useState } from "react";

interface EvidenceRow {
  content: string; source: string; sourceId: string; title: string | null;
  url: string; score: number; recency: string | null; tool: string;
}
interface PlanStage { tools: { name: string; query: string }[]; reasoning: string; fallback: boolean }
interface EvidenceStage { tool: string; rows: EvidenceRow[] }

type Stage =
  | { kind: "plan"; plan: PlanStage }
  | { kind: "evidence"; tool: string; rows: EvidenceRow[] }
  | { kind: "answer"; text: string };
```

Behavior contract:
- On mount, `fetch("/api/projects")` fills a `<select>` (options: all projects plus "all sources").
- Submit opens `new EventSource("/api/ask?q=...&project=...")`, resets stages, listens for `plan`, `evidence`, `answer`, `done`, `error`. Each event appends a Stage; `done` closes the source; `error` renders the message in a quiet red box.
- While the source is open and no `answer` stage exists, render three skeleton bars (`animate-pulse` on `bg-zinc-200 dark:bg-zinc-800` rounded divs).
- The plan card lists tool chips (mono, `bg-zinc-100 dark:bg-zinc-800 rounded px-1.5`) with the per-tool query in a muted span, plus the reasoning line, tagged "(fallback)" when `fallback` is true.
- Each evidence card is titled by tool name, and each row shows a source badge (two-letter mono: `co`, `ji`, `gh`, `bu`, `pe`), the title, the sourceId in mono, recency when present, and the first 160 chars of content, expandable on click (`<details>` is fine).
- The answer card renders the text with `[n]` replaced by accent-colored `<button>`s; clicking scrolls the nth evidence row into view (`scrollIntoView({ behavior: "smooth", block: "center" })`) and applies the `evidence-flash` class for 1.2s. Number rows globally in evidence-arrival order so `[n]` maps to the same numbering the synthesis prompt used: the answer's numbering is the deduped concatenation order, so build a flat `numbered: EvidenceRow[]` array from evidence stages, deduped on `source:sourceId`, matching `askStream`'s dedupe order, and use IT for both citation targets and the footnote list under the answer.
- Header: the repo title in small caps tracking-wide, and a one-line subtitle "watch a question move through the pipeline". Footer: a muted link to docs/00-overview.md on GitHub (relative href is fine).

- [ ] **Step 3: Build and verify against the live server**

Run: `pnpm -C packages/web build`
Expected: dist/ builds clean.

Run: `pnpm web` in the background, then `curl -s "http://localhost:8787/api/projects"` (expect the two projects) and `curl -sN "http://localhost:8787/api/ask?q=Why%20does%20checkpoint%20restore%20stall%3F&project=helios-eng" | head -30` (expect `event: plan` then `event: evidence` frames arriving). Open http://localhost:8787 in a browser if available and run one question end to end; otherwise the curl frames plus the built dist are sufficient evidence. Kill the server after.

- [ ] **Step 4: Full suite once**

Run: `pnpm test && pnpm typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Show the pipeline arriving stage by stage because seeing it is believing it"
```

---

### Task 5: Docs 00 through 04

**Files:**
- Create: `docs/00-overview.md`, `docs/01-schema.md`, `docs/02-ingestion.md`, `docs/03-distillation.md`, `docs/04-retrieval.md`

No code. Every page: at least one Mermaid diagram, links to the exact source files it explains (relative repo paths), 300 to 700 words of prose, written for a technical reader building their own KB. No em dashes, no double dashes anywhere.

**The measured surprises that MUST appear (these were earned during the build; docs that omit them are lying by omission):**
1. (04) IDF inversion: in a technical corpus, casual words score HIGHER idf than technical terms. Real numbers from this corpus: helios_prefetch_depth 2.829 (14 docs), thanks 3.52, sounds 5.47, helios 1.37. Consequence: the rare-token threshold (2.5) only skips ubiquitous terms; chatter suppression belongs to fusion and rerank. Cite `packages/core/src/retrieval/signals.ts`.
2. (04) websearch_to_tsquery AND semantics: the query "restore hangs after manifest load" produces an EMPTY fts list because no document contains all terms; vector and rare-token retrievers cover the gap. This is the concrete argument for multi-retriever fusion.
3. (03) Distillation quality collapses under rate limiting: the first live ingest degraded 138 of 188 rows on free-tier 429s until the client honored Retry-After with patient retries and 400ms pacing. Cite `packages/core/src/models/cerebras.ts`.

Per-page content contracts:

- `00-overview.md`: the vertical stack diagram (sources, distillation, embeddings, retrieval, fusion+rerank, synthesis) as a Mermaid flowchart; the three-pillar framing from the spec (collect, query, authn/authz with a pointer to 08); a table mapping this demo's sources to the blog's (Confluence to wiki, JIRA to incidents plus Slack-thread lessons, GitHub to code, bucket to custom); reading order = file order.
- `01-schema.md`: Mermaid erDiagram of embeddings, sources, projects, project_sources, token_idf; why one table wins (uniform query surface, one HNSW index, connectors stay independent); the metadata field inventory with which retriever or feature consumes each field; generated tsv column explained.
- `02-ingestion.md`: connector contract with the four implementations linked; Mermaid sequence of discover to distill to hash-check to embed to upsert; idempotency via content_hash; per-item, per-source, and per-row fault isolation (cite run.ts); the summary report fields; the test-database guard story in a callout: what happened, why count-based verification missed it, what the guard does now.
- `03-distillation.md`: embed the artifact, not the transcript, with the HEL-482 thread as the worked example (show the actual distilled JSON shape); bursting rules (IDF >= 4.0, 200 chars, title prepended) and what got filtered; the degradation contract (distilled false rows still land); surprise 3 above.
- `04-retrieval.md`: the five retrievers with a blind-spots table (each retriever, what it catches, what it misses, which sibling covers the miss); surprises 1 and 2 above with the real numbers; half-life table for recency; per-source scoped lists and the unknown-project guard.

- [ ] **Step 1: Write the five pages**
- [ ] **Step 2: Verify rendering: every Mermaid block parses (paste into mermaid.live or rely on a local check), every relative link resolves (`ls` each target), zero em or double dashes (`grep -rn "\-\-\|—" docs/0*.md` returns only CLI flags inside code fences; manually confirm each hit is inside a fence)**
- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "Teach the data plane with the numbers we actually measured"
```

---

### Task 6: Docs 05 through 09

**Files:**
- Create: `docs/05-fusion-rerank.md`, `docs/06-answer.md`, `docs/07-surfaces.md`, `docs/08-scaling.md`, `docs/09-write-your-own-connector.md`

Same rules as Task 5. Content contracts:

- `05-fusion-rerank.md`: RRF formula with K=60 and a REAL fusion table captured by running `pnpm kb search "restore hangs after manifest load" --project helios-eng --explain` against the live store and pasting the actual contribution table (trimmed to top 8); why consensus beats a single vote; dedupe and per-parent caps; rerank as a 0-10 batched call with the clamp; the measured observation that rerank can demote code chunks for definitional questions (rare-flag live eval, 9/10) and why that is honest behavior; context expansion AFTER ranking with the token-economics argument.
- `06-answer.md`: Mermaid sequenceDiagram of planner, executor, synthesis; the planner catalog and its fallback ladder (throw, malformed, unknown tools, all fall to plain search); evidence numbering and dedupe; the conflict-caveat behavior with the retention question's ACTUAL live answer quoted (14 days, supersedes 30-day wiki, citations to both); the trust boundary callout: evidence content is interpolated into the synthesis prompt unescaped, fine for a fixture corpus, a real deployment ingesting untrusted content must escape or fence it.
- `07-surfaces.md`: the three surfaces over one library (Mermaid diagram); CLI tour with real trimmed outputs of search --explain, ask --trace, who-knows; MCP setup: the exact `claude mcp add kb -- pnpm --dir /path/to/repo kb-mcp` line, the six tools, and a worked example transcript sketch of an agent chaining search then search_code; the web UI's SSE stages and how they map to askStream events; LLM-free degradation ladder per surface.
- `08-scaling.md`: an honesty table, one row per demo simplification: cron-style re-ingest vs Socket Mode push; regex chunker vs tree-sitter or CocoIndex (include the three known chunker quirks: sibling fusing, brace counting in strings, typed arrow consts); ILIKE rare-token candidates and the 200 cap vs a proper inverted index; no tombstones (deleted fixtures persist) vs sync state tracking; single Postgres vs partitioning and read replicas; no authn/authz/audit vs the blog's third pillar (per-source ACL mapping at query time); test-db guard vs real environment isolation; HNSW parameter defaults vs tuned m and ef_construction; last_synced watermark unused by fixture readers vs real incremental APIs; unescaped synthesis evidence vs prompt hardening.
- `09-write-your-own-connector.md`: full tutorial building a hypothetical `meetings` connector against the Connector contract in ~80 lines (the code compiles in your head; it is a doc, not a shipped module): discover from a JSON export, distill with a meeting-specific prompt, metadata fields, wiring into defaultConnectors and projects.json, then ingest and verify with kb search. End with the checklist: shape, hash stability, authoredAt, authors, url scheme, degradation.

- [ ] **Step 1: Capture the real outputs needed (search --explain table for 05, ask --trace answer for 06, CLI outputs for 07) by running the commands against the live store**
- [ ] **Step 2: Write the five pages**
- [ ] **Step 3: Same verification as Task 5 Step 2**
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Document the query plane and name every simplification out loud"
```

---

### Task 7: README, LICENSE, repo polish

**Files:**
- Rewrite: `README.md`
- Create: `LICENSE`
- Modify: root `package.json` (license field), `.env.example` (rotation comment)

Content contract for `README.md` (400 to 700 words plus blocks):
- Title, one-paragraph pitch: an open-source, runnable teaching implementation of the architecture in the Cerebras "How We Built Our Knowledge Base" post, with a link to the post and a clear "not affiliated with Cerebras; inspired by their write-up" line.
- The vertical-stack Mermaid diagram (same as docs/00, kept in sync manually).
- Quickstart, exactly these steps with expected timings: `podman compose up -d` (or docker), `pnpm install`, `cp .env.example .env` and add a Cerebras key (free tier link) or skip for retrieval-only, `pnpm kb init`, `pnpm kb ingest` (5 to 45 min depending on key tier; without a key it runs raw-text mode in ~3 min), then `pnpm kb search "why does checkpoint restore stall?" --project helios-eng --explain`.
- The three surfaces with one real trimmed output each; the MCP add one-liner; `pnpm web` for the UI.
- The eval: `pnpm eval` scorecard sample, the 10/10 retrieval and 9/10 live-rerank numbers with one sentence on the honest miss.
- Model table (distill gpt-oss-120b, planner and rerank gemma-4-31b, synthesis zai-glm-4.7, all env-overridable) and the local embedding model.
- Docs index table linking 00 through 09 with one-line hooks.
- A "what this is not" section: no auth, no live connectors, fixture data only, see docs/08.
- License line (MIT).

`LICENSE`: MIT, `Copyright (c) 2026 Gabe Rojas`.

`.env.example` gains a comment line: `# Rotate any key that has ever left your machine before making a repo public.`

Root `package.json` gains `"license": "MIT"`.

- [ ] **Step 1: Write the files, capturing the README's real outputs from the live store**
- [ ] **Step 2: Verification: quickstart commands each exist in package.json or compose; every docs link resolves; dash scan as before; Mermaid parses**
- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "Write the front door: a stranger should run this in five minutes and learn from it"
```

---

### Task 8: Final verification and merge readiness

**Files:** none new; fixes only if smokes fail.

- [ ] **Step 1: Full gates**

Run: `pnpm test && pnpm typecheck` (all green, 70+ tests)

- [ ] **Step 2: Live surface smokes against the real store**

1. `pnpm kb search "ERR_MANIFEST_TIMEOUT" --explain --no-llm | head -30` (fts leads with HEL-530 material)
2. `pnpm kb ask "Who should I talk to about the shard cache and what changed recently?" --trace | tail -20` (cited answer; who_knows or search evidence includes Priya)
3. The MCP stdio smoke from Task 2 Step 4 again (six tools listed)
4. `pnpm web` in background; `curl -sN "http://localhost:8787/api/ask?q=How%20long%20do%20we%20retain%20checkpoints%3F&project=helios-eng" | grep -c "event:"` returns at least 4; kill the server
5. `pnpm eval` (10/10 expected) and `pnpm eval --live` (9+/10 expected)

- [ ] **Step 3: Record all smoke outputs in the task report, then hand back for the whole-branch review**

The coordinator dispatches the final whole-branch review and the merge decision; this task ends with evidence, not a merge.

---

## Done means

A stranger clones the repo, runs five commands, asks a question three ways (CLI, MCP through Claude Code, web page), watches the pipeline explain itself, reads ten documents that tell the truth about what scales and what does not, and leaves knowing how to build the real thing. The repo is ready for `git push` the moment the API key is rotated and the name is confirmed.