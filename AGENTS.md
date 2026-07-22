# Agent operating notes

A runnable knowledge base over a fictional company, Helios. Four fixture sources (Confluence, JIRA, GitHub, a doc bucket) distilled into one Postgres table, queried by five parallel retrievers fused with RRF. You are the orchestrator; the MCP server only serves evidence.

## Setup, non-interactive

1. `podman compose up -d` (or `docker compose up -d`): Postgres with pgvector on port 5433.
2. `pnpm install`
3. `pnpm kb init`: green checkmarks when healthy. A missing `CEREBRAS_API_KEY` is a yellow warning, not a failure.
4. `pnpm kb ingest`: 5 to 45 minutes with a key (rate-limit pacing, not a hang), about 3 minutes without one.

Readiness: `pnpm kb search "checkpoint" --project helios-eng` returns rows once ingestion has run. Empty results before step 4 mean "not ingested", never "no evidence".

## The MCP server

Claude Code discovers it from the committed `.mcp.json`; approve the prompt on first use. Other MCP clients launch it with `pnpm --dir /path/to/repo kb-mcp` over stdio. Seven tools, all LLM-free, with input schemas generated from the parameters the code actually reads.

| Tool | Use when |
|---|---|
| `search` | most questions; hybrid across all sources, takes `project` and `limit` |
| `get_document` | a result is worth reading whole; pass any result's `url` or a bare id like `HEL-482` |
| `search_confluence`, `search_jira` | you already know which system holds the answer |
| `search_code` | exact flags, error strings, function names; `re:` prefix for regex; a trailing `meta` row reports truncation |
| `who_knows` | routing a question to a person |
| `list_projects` | first call in a new session; takes no arguments |

The investigation shape that works: `search` wide, `get_document` on the one or two urls worth reading in full, `search_code` to ground claims in source. Search returns ranked guesses; get returns the exact document a citation names. Url schemes: `jira://HEL-482`, `confluence://HELIOS/HEL-008`, `bucket://file.md`, `github://helios/src/path.ts`.

Reading results:

- `score` means what `scoreKind` says: `fused` is an RRF sum, roughly 0.01 to 0.1; `reranked` is an LLM grade from 0 to 10. Never compare across kinds.
- `retrieverAgreement` counts how many independent retrievers surfaced the row; 2 or more is a strong signal.
- Retrieval always fills its row budget. Uniformly low scores mean the corpus probably cannot answer; say that instead of citing the least-bad row.

## Degradation without a key

MCP tools and `kb search` always work, rerank is skipped. `kb ask` refuses and says why. `pnpm eval` grades retrieval only and skips the abstention questions; `pnpm eval --live` grades everything.

## Verification

`pnpm test` (needs the container up; uses an isolated `kb_test` database), `pnpm typecheck`, `pnpm eval`.
