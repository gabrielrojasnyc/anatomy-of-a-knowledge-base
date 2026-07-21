import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { getPool } from "../src/schema/db.js";
import { loadGolden, gradeQuestion } from "../src/answer/golden.js";
import { ensureCorpus } from "./helpers.js";

const ROOT = join(import.meta.dirname, "../../..");
const pool = getPool();
beforeAll(() => ensureCorpus(pool), 600_000);
afterAll(async () => {
  await pool.end();
});

describe("golden questions, retrieval only, raw-text corpus", () => {
  it("passes at least 8 of 10", { timeout: 300_000 }, async () => {
    const questions = loadGolden(join(ROOT, "eval/golden.json"));
    expect(questions).toHaveLength(10);
    const grades = [];
    for (const q of questions)
      grades.push(
        await gradeQuestion(pool, q, { fixturesDir: join(ROOT, "fixtures") }),
      );
    const failed = grades.filter((g) => !g.pass);
    expect(
      failed.length,
      `failed: ${failed.map((g) => `${g.id} (${g.details.join("; ")})`).join(" | ")}`,
    ).toBeLessThanOrEqual(2);
  });
});
