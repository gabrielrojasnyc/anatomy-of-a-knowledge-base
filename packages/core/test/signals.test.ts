import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../src/schema/db.js";
import { embedQuery } from "../src/models/embeddings.js";
import {
  rareTokenRetriever,
  recencyRetriever,
} from "../src/retrieval/signals.js";
import { ensureCorpus } from "./helpers.js";

const pool = getPool();
beforeAll(() => ensureCorpus(pool), 600_000);
afterAll(async () => {
  await pool.end();
});

describe("rareTokenRetriever", () => {
  it("ranks rows containing a rare flag above everything else", async () => {
    const list = await rareTokenRetriever(
      pool,
      "what is HELIOS_PREFETCH_DEPTH",
    );
    expect(list.name).toBe("rare");
    expect(list.docs.length).toBeGreaterThan(0);
    expect(list.docs[0].content.toLowerCase()).toContain(
      "helios_prefetch_depth",
    );
  });

  it("returns an empty list when every query token is common", async () => {
    const list = await rareTokenRetriever(pool, "helios checkpoint restore");
    expect(list.docs).toEqual([]);
  });

  it("ignores tokens whose idf sits below the default threshold", async () => {
    const { rows } = await pool.query(
      `SELECT token FROM token_idf WHERE idf BETWEEN 2.3 AND 2.9 ORDER BY idf DESC LIMIT 1`,
    );
    expect(rows.length).toBe(1);
    const list = await rareTokenRetriever(pool, rows[0].token);
    expect(list.docs).toEqual([]);
  });
});

describe("recencyRetriever", () => {
  it("prefers the newer of two deploy pages", async () => {
    const qvec = await embedQuery(
      "what is the current deploy process for Helios?",
    );
    const list = await recencyRetriever(pool, qvec, {
      sources: ["confluence"],
    });
    const rank21 = list.docs.findIndex((d) => d.sourceId.startsWith("HEL-021"));
    const rank20 = list.docs.findIndex((d) => d.sourceId.startsWith("HEL-020"));
    expect(rank21).toBeGreaterThanOrEqual(0);
    if (rank20 >= 0) expect(rank21).toBeLessThan(rank20);
  });
});
