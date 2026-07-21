import { join } from "node:path";
import { getPool, loadGolden, gradeQuestion, loadConfig, chat } from "@kb/core";

const live = process.argv.includes("--live");
const ROOT = join(import.meta.dirname, "..");

const pool = getPool();
const cfg = loadConfig();
const llm =
  live && cfg.cerebrasApiKey
    ? async (o: { model: string; system: string; user: string }) => {
        await new Promise((r) => setTimeout(r, 400));
        return chat({
          model: o.model,
          system: o.system,
          user: o.user,
          attempts: 5,
        });
      }
    : undefined;

if (live && !llm) {
  console.error("--live needs CEREBRAS_API_KEY");
  process.exit(2);
}

const questions = loadGolden(join(ROOT, "eval/golden.json"));
let passed = 0;
console.log(
  `golden eval, ${live ? "live rerank" : "retrieval only"}, db: ${cfg.databaseUrl}\n`,
);
for (const q of questions) {
  const g = await gradeQuestion(pool, q, {
    fixturesDir: join(ROOT, "fixtures"),
    llm,
  });
  if (g.pass) passed++;
  console.log(
    `${g.pass ? "PASS" : "FAIL"}  ${q.id.padEnd(20)} ${g.details.join("; ")}`,
  );
}
console.log(`\n${passed}/${questions.length} passed`);
await pool.end();
process.exit(passed >= 8 ? 0 : 1);
