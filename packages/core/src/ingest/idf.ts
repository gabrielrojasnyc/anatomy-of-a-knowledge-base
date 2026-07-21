import type pg from "pg";

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have i in is it its of on " +
    "or that the this to was were will with you your we our they he she not no yes do does did " +
    "can could should would may might just also very"
  ).split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
    (t) => t.length >= 3 && !STOPWORDS.has(t),
  );
}

export function computeIdf(
  docs: string[][],
): Map<string, { docCount: number; idf: number }> {
  const counts = new Map<string, number>();
  for (const doc of docs)
    for (const tok of new Set(doc)) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  const n = docs.length;
  const out = new Map<string, { docCount: number; idf: number }>();
  for (const [tok, c] of counts)
    out.set(tok, { docCount: c, idf: Math.log(n / c) });
  return out;
}

export async function rebuildTokenIdf(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query(`SELECT content FROM embeddings`);
  const idf = computeIdf(rows.map((r) => tokenize(r.content)));
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
        `INSERT INTO token_idf (token, doc_count, idf) VALUES ${tuples.join(",")}`,
        values,
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
    `SELECT coalesce(max(idf), 0) AS m FROM token_idf WHERE token = ANY($1)`,
    [tokens],
  );
  return Number(rows[0].m);
}
