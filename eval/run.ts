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
let skipped = 0;
const reciprocalRanks: number[] = [];
const dbLabel = (() => {
  try {
    const u = new URL(cfg.databaseUrl);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(unparseable url)";
  }
})();
console.log(
  `golden eval, ${live ? "live rerank" : "retrieval only"}, db: ${dbLabel}\n`,
);
for (const q of questions) {
  const g = await gradeQuestion(pool, q, {
    fixturesDir: join(ROOT, "fixtures"),
    llm,
  });
  if (g.skipped) skipped++;
  else if (g.pass) passed++;
  reciprocalRanks.push(...(g.reciprocalRanks ?? []));
  const label = g.skipped ? "SKIP" : g.pass ? "PASS" : "FAIL";
  console.log(`${label}  ${q.id.padEnd(20)} ${g.details.join("; ")}`);
}
// MRR is the early-warning trend: a hit sliding from rank 2 to rank 9 moves
// this number long before it falls off the top 10 and flips a PASS to FAIL.
const gradable = questions.length - skipped;
const mrr = reciprocalRanks.length
  ? reciprocalRanks.reduce((a, b) => a + b, 0) / reciprocalRanks.length
  : null;
console.log(
  `\n${passed}/${gradable} passed` +
    (skipped ? `, ${skipped} skipped` : "") +
    (mrr !== null
      ? `, MRR ${mrr.toFixed(2)} over ${reciprocalRanks.length} expected hits`
      : ""),
);
await pool.end();
process.exit(passed >= gradable - 2 ? 0 : 1);
