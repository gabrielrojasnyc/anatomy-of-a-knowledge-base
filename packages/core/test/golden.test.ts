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
  it(
    "passes all but two gradable questions",
    { timeout: 300_000 },
    async () => {
      const questions = loadGolden(join(ROOT, "eval/golden.json"));
      expect(questions).toHaveLength(12);
      const grades = [];
      for (const q of questions)
        grades.push(
          await gradeQuestion(pool, q, { fixturesDir: join(ROOT, "fixtures") }),
        );
      // Abstention questions need rerank, so a retrieval-only run skips them.
      const skipped = grades.filter((g) => g.skipped);
      expect(skipped.map((g) => g.id).sort()).toEqual([
        "abstain-kubernetes",
        "abstain-windows",
      ]);
      const failed = grades.filter((g) => !g.skipped && !g.pass);
      expect(
        failed.length,
        `failed: ${failed.map((g) => `${g.id} (${g.details.join("; ")})`).join(" | ")}`,
      ).toBeLessThanOrEqual(2);
    },
  );
});
