# Anatomy of a Knowledge Base: Design Spec

Date: 2026-07-21
Status: Approved pending user review
Reference: [How We Built Our Knowledge Base](https://www.cerebras.ai/blog/how-we-built-our-knowledge-base), Cerebras, July 2026

## 1. Purpose and audience

An open-source teaching repo that shows a technical team, end to end, how to build an internal knowledge base at scale in the style of Cerebras Knowledge. The audience is Gabe's internal team: technical people actively figuring out how to build this. The repo optimizes for learnability: every architectural decision is visible, inspectable, and documented with the reasoning behind it. It will be pushed to GitHub as a public repository.

Success criteria:

- Anyone clones the repo and gets a working, queryable knowledge base in about five minutes with one optional API key.
- Every pipeline stage can be inspected mid-flight from the CLI.
- The docs teach both the demo implementation and what changes at production scale.
- A measurable eval proves retrieval quality instead of asserting it.

## 2. Locked decisions

| Decision | Choice |
|----------|--------|
| Audience | Internal technical team, published as public OSS |
| Data sources | Confluence, JIRA, GitHub (code), object bucket |
| Data mode | Fully synthetic, offline, fixture files only. No live API connectors. |
| Sample real content | Gabe's Production Notes posts live in the bucket fixture |
| Surfaces | CLI with inspectable stages, MCP server, minimal web UI |
| LLM | Cerebras Inference API (verified working, key in `.env`, gitignored) |
| Embeddings | Local via @huggingface/transformers (transformers.js), Xenova/bge-small-en-v1.5, 384 dimensions, no key needed |
| Stack | TypeScript monorepo, pnpm workspaces |
| Database | Postgres + pgvector via Podman (`compose.yaml`) |
| Repo name | `anatomy-of-a-knowledge-base` (changeable before publish) |

Available models on the verified key: `zai-glm-4.7`, `gemma-4-31b`, `gpt-oss-120b`. Smoke test round trip measured at 124 ms.

## 3. Architecture overview

The system mirrors the blog's vertical stack:

```
SOURCES        confluence, jira, github, bucket (fixture readers, one connector each)
DISTILLATION   LLM extractors normalize raw content into consistent artifacts
EMBEDDINGS     one Postgres table, pgvector 384-dim, HNSW + GIN indexes
RETRIEVAL      five ranked lists in parallel (FTS, vector, rare-token, recency, scoped)
FUSION         reciprocal rank fusion (K=60), dedup, per-file caps
RERANK         LLM scores top 20 from 0 to 10, keep top 10, then context expansion
SYNTHESIS      planner chooses tools, executor fans out, synthesizer cites evidence
```

`packages/core` implements the whole pipeline as a library. `cli`, `mcp`, and `web` are thin front doors over the same primitives. That layering is itself the lesson from the blog: MCP exposes raw retrieval primitives while the web UI runs the full planner, executor, synthesis loop over identical building blocks.

## 4. Repo layout

```
anatomy-of-a-knowledge-base/
├── compose.yaml            # podman compose: postgres + pgvector
├── fixtures/
│   ├── confluence/         # ~25 pages, JSON shaped like a real space export
│   ├── jira/               # ~40 issues with comment threads, real API shape
│   ├── github/helios/      # small real TypeScript codebase (~30 files)
│   └── bucket/             # markdown: Production Notes posts + synthetic drafts
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── schema/     # types, migrations, db client
│   │       ├── models/     # cerebras client, local embeddings
│   │       ├── ingest/     # connector contract, 4 connectors, distillers
│   │       ├── retrieval/  # 5 retrievers, rrf, rerank, expansion
│   │       └── answer/     # planner, executor, synthesis
│   ├── cli/                # kb command
│   ├── mcp/                # stdio MCP server
│   └── web/                # Hono + Vite + React + Tailwind
├── eval/                   # golden questions + recall@10 scorecard
└── docs/                   # numbered teaching docs with Mermaid diagrams
```

## 5. Fixture scenario

Fictional company running **Helios**, a model-serving platform. The corpora interlock so cross-source retrieval demos honestly:

- Confluence runbooks and RFCs reference real file paths in the code fixture.
- JIRA incidents discuss the same subsystems and link Confluence page titles.
- The Helios TypeScript codebase actually implements what the tickets discuss (checkpoint loader, manifest parser, config handling), so code chunks are real evidence.
- The bucket holds Production Notes posts (real content, publicly Gabe's) plus a few synthetic company blog drafts.

Two projects demonstrate scoped search:

- `helios-eng`: Confluence + JIRA + GitHub
- `content`: bucket only

About 10 golden questions ship with known expected evidence. Several are cross-source. One is authored so JIRA and Confluence conflict, exercising the synthesis caveat path. Golden questions double as the eval suite.

## 6. Data model

Single `embeddings` table, plus four small support tables.

```sql
embeddings (
  id            bigserial primary key,
  source        text not null,        -- 'confluence' | 'jira' | 'github' | 'bucket'
  source_id     text not null,        -- page id, issue key, file#chunk, object key
  kind          text not null,        -- 'page_section' | 'issue_thread' | 'comment_burst'
                                      -- | 'code_chunk' | 'doc_section'
  title         text,
  content       text not null,        -- normalized document, this is what gets embedded
  raw           jsonb,                -- original payload, used for context expansion
  metadata      jsonb not null,       -- authors, url, labels, path, systems, code_refs
  authored_at   timestamptz,          -- drives age decay
  content_hash  text not null,        -- skip unchanged rows on re-ingest
  embedding     vector(384),
  tsv           tsvector generated always as
                (to_tsvector('english', coalesce(title,'') || ' ' || content)) stored,
  unique (source, source_id)
)
```

Indexes: HNSW on `embedding` (cosine), GIN on `tsv`.

Support tables: `sources` (registry, config, last-sync watermark), `projects`, `project_sources` (scoping join), `token_idf` (corpus token statistics, rebuilt after each ingest, powers burst filtering and the rare-token retriever).

## 7. Ingestion and distillation

Connector contract, one per source:

```ts
interface Connector {
  source: string;
  discover(): AsyncIterable<RawItem>;      // reads fixture directory
  distill(item: RawItem): Promise<EmbeddingRow[]>;
}
```

Per-source behavior:

- **JIRA** (the showcase): issue + comments go to Cerebras with an extraction prompt, returning `{question, summary, resolution, systems, code_refs}`. The flattened artifact is embedded, one row per thread. Then bursting: consecutive same-author comment runs qualify for their own embedding when they contain a token with IDF of at least 4.0 and total at least 200 characters. Qualifying bursts embed with the issue title prepended as context. Filtered bursts are logged with the reason.
- **Confluence**: pages split by heading into sections. Each section distilled to summary plus key facts, embedded with page title prepended. Section order kept in metadata for neighbor expansion.
- **GitHub**: no LLM. Language-aware recursive chunker tries coarse boundaries first (class, then function, then block) and falls back finer only when a chunk exceeds the size limit. Content hash means only changed files re-embed.
- **Bucket**: markdown sections, front matter becomes metadata. Distiller extracts `{topic, thesis, key_points}` per post.

Idempotency: upsert on `(source, source_id)`, `content_hash` short-circuits unchanged rows. Per-item fault isolation: a failed distillation retries three times, then writes the row with raw text embedded and `metadata.distilled = false`. Ingest ends with a summary report: ingested, skipped, degraded counts.

## 8. Retrieval, fusion, rerank

Five retrievers, each returning a ranked list over the same corpus:

1. **Full-text**: `websearch_to_tsquery` + `ts_rank` over GIN. Exact tokens, error strings, flag names.
2. **Vector**: pgvector cosine over HNSW. Paraphrase.
3. **Rare-token**: high-IDF query tokens fetch rows containing them, ranked by summed rarity.
4. **Recency-weighted vector**: vector list rescored with exponential age decay on `authored_at`. Half-life configurable per source (JIRA decays fast, code barely).
5. **Scoped-source lists**: inside a project, each in-scope source contributes its own vector list.

Fusion: RRF with K=60. Score is the sum of `weight / (60 + rank)` per list. Implementation is small, pure, dependency-free TypeScript. After fusion: chunks from the same document merge to the best-ranked representative, max 3 results per file or page.

Rerank: fused top 20 to Cerebras (`gemma-4-31b`) with the original question, each candidate scored 0 to 10, keep top 10.

Context expansion happens only after ranking is final: Confluence and bucket sections pull two neighboring sections from `raw`, code chunks pull the enclosing scope, JIRA threads attach the resolution comment verbatim.

Degradation: without `CEREBRAS_API_KEY`, `kb search` runs the full LLM-free pipeline through fusion and labels the missing rerank step.

## 9. Answer pipeline

| Step | Model | Rationale |
|------|-------|-----------|
| Distillation | `gpt-oss-120b` | Strongest structured extraction, runs once per document at ingest |
| Planner | `gemma-4-31b` | Tool selection is a cheap classification pass |
| Rerank | `gemma-4-31b` | The blog uses a small reranker; fastest model fits |
| Synthesis | `zai-glm-4.7` | User-facing cited answer deserves the strongest writer |

All model IDs configurable via env.

Flow: planner receives the question plus a compact catalog of projects, sources, and what each answers well, then emits tool selections. Executor fans out in parallel, normalizes everything to `EvidenceRow` (content, source, score, recency, citation URL). Synthesis receives the typed evidence bundle and produces the answer with numbered citations mapping to fixture URLs, including caveats when evidence conflicts.

Tools (six, each one pipeline, LLM-free): `search`, `search_code` (regex over the code fixture), `search_jira`, `search_confluence`, `who_knows` (ranks people by authorship over top-matching evidence), `list_projects`.

Failure behavior: planner failure falls back to plain `search`; rerank failure keeps fused order, labeled; Cerebras errors retry three times with backoff.

## 10. Surfaces

- **CLI** (`kb`): `ingest`, `search` with `--explain` (per-retriever lists, the RRF fusion table with real contribution math, rerank scores), `ask` with `--trace` (planner reasoning, tool fan-out, evidence, streamed cited answer), `who-knows`. The `--explain` fusion table is the repo's single best teaching artifact.
- **MCP server**: stdio transport, exposes the six tools with narrow stable schemas. README ships the `claude mcp add` one-liner. Docs include a worked example of Claude Code chaining `search` and `search_code`.
- **Web UI**: one page. Question in, pipeline visualized: planner decision appears, evidence table fills per tool over SSE, answer streams with citations that expand to the underlying evidence row. Hono server, Vite + React + Tailwind, no component library.

## 11. Documentation plan

Docs are numbered in pipeline order so reading order equals data-flow order. Every page pairs a Mermaid diagram with links to the exact source files it explains.

```
README.md                  # what and why, 5-minute quickstart, full-stack diagram
docs/00-overview.md        # the anatomy, full architecture Mermaid
docs/01-schema.md          # ERD, why one table wins, metadata design
docs/02-ingestion.md       # connector contract, flow diagram, idempotency
docs/03-distillation.md    # embed the artifact not the transcript; a real fixture
                           # thread walked end to end; bursting
docs/04-retrieval.md       # five retrievers, blind-spots table
docs/05-fusion-rerank.md   # RRF with real fixture numbers, rerank, expansion
docs/06-answer.md          # planner, executor, synthesis sequence diagram
docs/07-surfaces.md        # CLI, MCP setup for Claude Code, web UI
docs/08-scaling.md         # demo simplification vs production reality, one row each:
                           # cron re-ingest vs Socket Mode, sync chunker vs CocoIndex,
                           # HNSW tuning, partitioning, authn/authz and audit
docs/09-write-your-own-connector.md   # tutorial: fifth source in ~80 lines
```

Writing rules: no double dashes and no em dashes anywhere in prose. Diagrams render on GitHub natively.

## 12. Testing and eval

- **Unit (Vitest)**: chunker boundaries, RRF against a hand-computed table, IDF stats, age decay, burst filter thresholds.
- **Integration**: golden-question eval. Ingest fixtures into a throwaway Podman Postgres, run retrieval, assert expected evidence in top 10 (recall@10). CI uses recorded LLM responses, no key required.
- **Live eval**: `pnpm eval --live` runs the full pipeline against Cerebras and prints a scorecard. The scorecard is a documented artifact: this is how you measure a KB.

## 13. Out of scope

- Live API connectors for Confluence, JIRA, GitHub, S3 (fixture readers keep the connector contract honest; `docs/09` shows the path).
- Authentication, authorization, auditing (covered as a design discussion in `docs/08-scaling.md`, not implemented).
- Real-time ingest (Socket Mode equivalent), queues, horizontal scaling.
- Slack as a source. JIRA comment threads carry the thread-distillation lesson instead.

## 14. Open items

- Rotate the Cerebras key before the repo goes public (it passed through chat).
- Confirm final repo name before pushing to GitHub.
- Select which Production Notes posts go in the bucket fixture.
