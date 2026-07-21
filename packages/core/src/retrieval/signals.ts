import type pg from "pg";
import { tokenize } from "../ingest/idf.js";
import { vectorRetriever } from "./retrievers.js";
import type { RankedList, RetrievedDoc } from "./types.js";

export const HALF_LIFE_DAYS: Record<string, number> = {
  jira: 90,
  confluence: 180,
  bucket: 365,
  github: 3650,
};

export async function rareTokenRetriever(
  pool: pg.Pool,
  query: string,
  opts: { sources?: string[]; limit?: number; minIdf?: number } = {},
): Promise<RankedList> {
  const minIdf = opts.minIdf ?? 2.0;
  const tokens = [...new Set(tokenize(query))];
  const { rows: idfRows } = await pool.query(
    `SELECT token, idf FROM token_idf WHERE token = ANY($1) AND idf >= $2
      ORDER BY idf DESC LIMIT 5`,
    [tokens, minIdf],
  );
  if (idfRows.length === 0) return { name: "rare", docs: [] };
  const rare = new Map(idfRows.map((r) => [r.token as string, Number(r.idf)]));
  const patterns = [...rare.keys()].map((t) => `%${t}%`);
  const { rows } = await pool.query(
    `SELECT id, source, source_id, kind, title, content, metadata, authored_at
       FROM embeddings
      WHERE content ILIKE ANY($1) AND ($2::text[] IS NULL OR source = ANY($2))
      LIMIT 200`,
    [patterns, opts.sources ?? null],
  );
  const docs: RetrievedDoc[] = rows
    .map((r) => {
      const present = new Set(tokenize(r.content as string));
      let score = 0;
      for (const [tok, idf] of rare) if (present.has(tok)) score += idf;
      return {
        id: Number(r.id),
        source: r.source,
        sourceId: r.source_id,
        kind: r.kind,
        title: r.title ?? null,
        content: r.content,
        metadata: r.metadata ?? {},
        authoredAt: r.authored_at ? new Date(r.authored_at) : null,
        score,
      };
    })
    .filter((d) => d.score > 0);
  docs.sort((a, b) => b.score - a.score);
  return { name: "rare", docs: docs.slice(0, opts.limit ?? 50) };
}

export async function recencyRetriever(
  pool: pg.Pool,
  qvec: number[],
  opts: { sources?: string[]; limit?: number } = {},
): Promise<RankedList> {
  const base = await vectorRetriever(pool, qvec, {
    sources: opts.sources,
    limit: 100,
  });
  const now = Date.now();
  const docs = base.docs.map((d) => {
    const half = HALF_LIFE_DAYS[d.source] ?? 365;
    const ageDays = d.authoredAt
      ? Math.max(0, (now - d.authoredAt.getTime()) / 86_400_000)
      : half;
    return { ...d, score: d.score * Math.exp((-ageDays * Math.LN2) / half) };
  });
  docs.sort((a, b) => b.score - a.score);
  return { name: "recency", docs: docs.slice(0, opts.limit ?? 50) };
}
