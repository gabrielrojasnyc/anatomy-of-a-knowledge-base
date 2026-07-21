import { join } from "node:path";
import type pg from "pg";
import { migrate } from "../src/schema/migrate.js";
import { runIngest } from "../src/ingest/run.js";

const ROOT = join(import.meta.dirname, "../../..");

export function assertTestDatabase(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (!/_test$/.test(url.split("?")[0]))
    throw new Error(
      `Refusing to run destructive tests against "${url || "(default live database)"}". ` +
        `Tests must run through the root vitest config, which targets kb_test.`,
    );
  return url;
}

export async function ensureCorpus(pool: pg.Pool): Promise<void> {
  assertTestDatabase();
  await migrate(pool);
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM embeddings) AS n,
            EXISTS(SELECT 1 FROM embeddings WHERE content LIKE '%distilled summary%') AS mock`,
  );
  if (rows[0].n >= 200 && !rows[0].mock) return;
  await pool.query(
    `TRUNCATE embeddings, token_idf, project_sources, projects, sources`,
  );
  await runIngest(pool, {
    fixturesDir: join(ROOT, "fixtures"),
    distillModel: "none",
    log: () => {},
  });
}
