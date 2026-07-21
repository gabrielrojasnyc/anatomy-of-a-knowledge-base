import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../src/schema/db.js";
import { migrate } from "../src/schema/migrate.js";

const pool = getPool();

describe("schema", () => {
  beforeAll(async () => {
    await migrate(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("creates all five tables", async () => {
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
    );
    const names = rows.map((r) => r.tablename);
    for (const t of [
      "embeddings",
      "projects",
      "project_sources",
      "sources",
      "token_idf",
    ])
      expect(names).toContain(t);
  });

  it("is idempotent", async () => {
    await migrate(pool);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM schema_migrations`,
    );
    expect(rows[0].n).toBe(1);
  });

  it("accepts a 384-dim vector and rejects other sizes", async () => {
    const v = `[${Array(384).fill(0.1).join(",")}]`;
    await pool.query(
      `INSERT INTO embeddings (source, source_id, kind, title, content, metadata, content_hash, embedding)
       VALUES ('bucket','t1','doc_section','t','hello world','{}','h1',$1)
       ON CONFLICT (source, source_id) DO NOTHING`,
      [v],
    );
    await expect(
      pool.query(
        `UPDATE embeddings SET embedding='[1,2,3]' WHERE source_id='t1'`,
      ),
    ).rejects.toThrow();
    await pool.query(`DELETE FROM embeddings WHERE source_id='t1'`);
  });
});
