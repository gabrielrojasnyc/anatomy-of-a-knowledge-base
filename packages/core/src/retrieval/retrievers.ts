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
  pool: pg.Pool,
  query: string,
  opts: { sources?: string[]; limit?: number } = {},
): Promise<RankedList> {
  const { rows } = await pool.query(
    `SELECT ${COLS}, ts_rank(tsv, q) AS score
       FROM embeddings, websearch_to_tsquery('english', $1) q
      WHERE tsv @@ q AND ($2::text[] IS NULL OR source = ANY($2))
      ORDER BY score DESC LIMIT $3`,
    [query, opts.sources ?? null, opts.limit ?? 50],
  );
  return { name: "fts", docs: rows.map((r) => toDoc(r, Number(r.score))) };
}

export async function vectorRetriever(
  pool: pg.Pool,
  qvec: number[],
  opts: { sources?: string[]; limit?: number; name?: string } = {},
): Promise<RankedList> {
  const lit = `[${qvec.join(",")}]`;
  const { rows } = await pool.query(
    `SELECT ${COLS}, 1 - (embedding <=> $1::vector) AS score
       FROM embeddings
      WHERE embedding IS NOT NULL AND ($2::text[] IS NULL OR source = ANY($2))
      ORDER BY embedding <=> $1::vector LIMIT $3`,
    [lit, opts.sources ?? null, opts.limit ?? 50],
  );
  return {
    name: opts.name ?? "vector",
    docs: rows.map((r) => toDoc(r, Number(r.score))),
  };
}

export async function projectSources(
  pool: pg.Pool,
  project: string,
): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT source FROM project_sources WHERE project = $1`,
    [project],
  );
  return rows.map((r) => r.source as string);
}
