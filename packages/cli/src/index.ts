import { Command } from "commander";
import pc from "picocolors";
import { join } from "node:path";
import {
  ask,
  buildTools,
  chat,
  getPool,
  loadConfig,
  migrate,
  runIngest,
  search,
} from "@kb/core";

const FIXTURES = join(process.cwd(), "fixtures");
const program = new Command()
  .name("kb")
  .description("Anatomy of a knowledge base");

program
  .command("init")
  .description("Run migrations and verify the stack")
  .action(async () => {
    const pool = getPool();
    try {
      await migrate(pool);
      console.log(pc.green("✓ schema migrated"));
      const cfg = loadConfig();
      if (!cfg.cerebrasApiKey) {
        console.log(
          pc.yellow(
            "! CEREBRAS_API_KEY not set: ingest will skip distillation",
          ),
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
    } finally {
      await pool.end();
    }
  });

program
  .command("ingest")
  .description("Ingest fixture sources into the embeddings table")
  .option("--source <name...>", "limit to specific sources")
  .option("--no-llm", "skip distillation even if a key is present")
  .action(async (opts: { source?: string[]; llm: boolean }) => {
    const cfg = loadConfig();
    const pool = getPool();
    try {
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
      console.log(
        pc.bold("\nsource       ingested  skipped  degraded  failed"),
      );
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
    } finally {
      await pool.end();
    }
  });

const llmOrUndefined = (use: boolean) => {
  const cfg = loadConfig();
  if (!use || !cfg.cerebrasApiKey) return undefined;
  return async (o: { model: string; system: string; user: string }) => {
    await new Promise((r) => setTimeout(r, 400));
    return chat({
      model: o.model,
      system: o.system,
      user: o.user,
      attempts: 5,
    });
  };
};

const fmtScore = (n: number) =>
  n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");

program
  .command("search <query>")
  .description("Hybrid search with optional pipeline explanation")
  .option("--project <name>", "scope to a project")
  .option(
    "--explain",
    "print each retriever list, the RRF table, and rerank scores",
  )
  .option("--no-llm", "skip the rerank step")
  .action(
    async (
      query: string,
      opts: { project?: string; explain?: boolean; llm: boolean },
    ) => {
      const pool = getPool();
      try {
        const llm = llmOrUndefined(opts.llm);
        if (opts.llm && !llm)
          console.log(pc.yellow("no CEREBRAS_API_KEY: rerank skipped"));
        const { evidence, trace } = await search(pool, query, {
          project: opts.project,
          llm,
          fixturesDir: FIXTURES,
        });
        if (opts.explain) {
          for (const list of trace.lists) {
            console.log(pc.bold(`\n[${list.name}]`));
            list.top
              .slice(0, 5)
              .forEach((d, i) =>
                console.log(
                  `  ${i + 1}. ${d.sourceId.padEnd(40)} ${fmtScore(d.score)}`,
                ),
              );
          }
          console.log(
            pc.bold("\n[rrf fusion] score = sum of weight / (60 + rank)"),
          );
          for (const f of trace.fused.slice(0, 10)) {
            const parts = f.contributions
              .map((c) => `${c.list}#${c.rank}:${fmtScore(c.contribution)}`)
              .join(" + ");
            console.log(
              `  ${f.sourceId.padEnd(40)} ${fmtScore(f.score)}  = ${parts}`,
            );
          }
          console.log(
            pc.bold(
              `\n[rerank] ${trace.rerank.applied ? "applied" : "skipped"}`,
            ),
          );
          for (const s of trace.rerank.scores.slice(0, 10))
            console.log(`  ${s.sourceId.padEnd(40)} ${s.score}/10`);
        }
        console.log(pc.bold("\nresults"));
        evidence.forEach((e, i) => {
          console.log(
            `${i + 1}. ${pc.cyan(e.title ?? e.sourceId)} ${pc.dim(`(${e.url})`)}`,
          );
          console.log(
            pc.dim(`   ${e.content.split("\n")[0]?.slice(0, 100) ?? ""}`),
          );
        });
      } finally {
        await pool.end();
      }
    },
  );

program
  .command("ask <question>")
  .description("Planner, executor, synthesis: a cited answer")
  .option("--project <name>", "scope to a project")
  .option("--trace", "print the planner decision and evidence table")
  .action(
    async (question: string, opts: { project?: string; trace?: boolean }) => {
      const pool = getPool();
      try {
        const llm = llmOrUndefined(true);
        if (!llm) {
          console.log(
            pc.red(
              "kb ask needs CEREBRAS_API_KEY (retrieval-only mode: use kb search)",
            ),
          );
          return;
        }
        const result = await ask(pool, question, {
          project: opts.project,
          fixturesDir: FIXTURES,
          llm,
        });
        if (opts.trace) {
          console.log(
            pc.bold("[planner] ") +
              result.plan.reasoning +
              (result.plan.fallback ? pc.yellow(" (fallback)") : ""),
          );
          for (const t of result.plan.tools)
            console.log(pc.dim(`  ${t.name}("${t.query}")`));
          console.log(pc.bold("\n[evidence]"));
          result.evidence.forEach((e, i) =>
            console.log(
              pc.dim(`  [${i + 1}] ${e.source} ${e.sourceId} ${e.url}`),
            ),
          );
        }
        console.log(pc.bold("\nanswer\n") + result.answer);
        console.log(pc.dim("\ncitations"));
        result.evidence.forEach((e, i) =>
          console.log(pc.dim(`  [${i + 1}] ${e.url}`)),
        );
      } finally {
        await pool.end();
      }
    },
  );

program
  .command("who-knows <topic>")
  .description("People with demonstrated expertise on a topic")
  .action(async (topic: string) => {
    const pool = getPool();
    try {
      const tools = buildTools(pool, {
        fixturesDir: FIXTURES,
      });
      const rows = await tools
        .find((t) => t.name === "who_knows")!
        .run({ query: topic });
      if (rows.length === 0) {
        console.log("no signal for that topic");
        return;
      }
      for (const r of rows)
        console.log(`${pc.cyan(r.sourceId.padEnd(20))} ${pc.dim(r.content)}`);
    } finally {
      await pool.end();
    }
  });

await program.parseAsync();
