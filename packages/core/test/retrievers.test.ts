import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../src/schema/db.js";
import { embedQuery } from "../src/models/embeddings.js";
import {
  ftsRetriever,
  vectorRetriever,
  projectSources,
} from "../src/retrieval/retrievers.js";
import { ensureCorpus } from "./helpers.js";

const pool = getPool();

beforeAll(() => ensureCorpus(pool), 600_000);
afterAll(async () => {
  await pool.end();
});

describe("ftsRetriever", () => {
  it("finds exact tokens like error strings", async () => {
    const list = await ftsRetriever(pool, "ERR_MANIFEST_TIMEOUT");
    expect(list.name).toBe("fts");
    expect(list.docs.length).toBeGreaterThan(0);
    expect(list.docs[0].content).toContain("ERR_MANIFEST_TIMEOUT");
    expect(list.docs[0].score).toBeGreaterThan(0);
  });

  it("respects a source filter", async () => {
    const list = await ftsRetriever(pool, "checkpoint restore", {
      sources: ["confluence"],
    });
    for (const d of list.docs) expect(d.source).toBe("confluence");
  });
});

describe("vectorRetriever", () => {
  it("catches paraphrase with no shared vocabulary", async () => {
    const qvec = await embedQuery(
      "the model server refuses to boot after I changed its settings",
    );
    const list = await vectorRetriever(pool, qvec, { limit: 20 });
    expect(list.name).toBe("vector");
    expect(list.docs.some((d) => d.sourceId.startsWith("HEL-007"))).toBe(true);
  });

  it("orders by descending similarity", async () => {
    const qvec = await embedQuery("checkpoint restore stalls");
    const { docs } = await vectorRetriever(pool, qvec, { limit: 10 });
    for (let i = 1; i < docs.length; i++)
      expect(docs[i - 1].score).toBeGreaterThanOrEqual(docs[i].score);
  });
});

describe("projectSources", () => {
  it("maps projects to their sources", async () => {
    expect((await projectSources(pool, "helios-eng")).sort()).toEqual([
      "confluence",
      "github",
      "jira",
    ]);
    expect(await projectSources(pool, "content")).toEqual(["bucket"]);
  });
});
