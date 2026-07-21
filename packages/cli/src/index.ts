import { Command } from "commander";
import pc from "picocolors";
import { join } from "node:path";
import { chat, getPool, loadConfig, migrate, runIngest } from "@kb/core";

const FIXTURES = join(process.cwd(), "fixtures");
const program = new Command()
  .name("kb")
  .description("Anatomy of a knowledge base");

program
  .command("init")
  .description("Run migrations and verify the stack")
  .action(async () => {
    const pool = getPool();
    await migrate(pool);
    console.log(pc.green("✓ schema migrated"));
    const cfg = loadConfig();
    if (!cfg.cerebrasApiKey) {
      console.log(
        pc.yellow("! CEREBRAS_API_KEY not set: ingest will skip distillation"),
      );
    } else {
      const reply = await chat({
        model: cfg.models.planner,
        system: "Reply with exactly: ok",
        user: "healthcheck",
        maxTokens: 10,
      });
      console.log(
        pc.green(
          `✓ cerebras reachable (${cfg.models.planner}: ${reply.trim()})`,
        ),
      );
    }
    await pool.end();
  });

program
  .command("ingest")
  .description("Ingest fixture sources into the embeddings table")
  .option("--source <name...>", "limit to specific sources")
  .option("--no-llm", "skip distillation even if a key is present")
  .action(async (opts: { source?: string[]; llm: boolean }) => {
    const cfg = loadConfig();
    const pool = getPool();
    await migrate(pool);
    const useLlm = opts.llm && Boolean(cfg.cerebrasApiKey);
    if (!useLlm)
      console.log(
        pc.yellow("running without distillation (degraded rows will say so)"),
      );
    const started = Date.now();
    const summary = await runIngest(pool, {
      fixturesDir: FIXTURES,
      sources: opts.source,
      distillModel: cfg.models.distill,
      // Free tier rate limits are real; pace requests and retry patiently.
      llm: useLlm
        ? async (o) => {
            await new Promise((r) => setTimeout(r, 400));
            return chat({
              model: o.model,
              system: o.system,
              user: o.user,
              attempts: 5,
            });
          }
        : undefined,
      log: (m) => console.log(pc.dim(`  ${m}`)),
    });
    console.log(pc.bold("\nsource       ingested  skipped  degraded  failed"));
    for (const [src, s] of Object.entries(summary.perSource)) {
      console.log(
        `${src.padEnd(12)} ${String(s.ingested).padStart(8)} ${String(s.skipped).padStart(8)}` +
          ` ${String(s.degraded).padStart(9)} ${String(s.failed).padStart(7)}`,
      );
    }
    console.log(
      pc.dim(
        `\n${summary.tokens} idf tokens, ${((Date.now() - started) / 1000).toFixed(1)}s`,
      ),
    );
    await pool.end();
  });

await program.parseAsync();
