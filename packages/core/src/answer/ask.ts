import type pg from "pg";
import { loadConfig } from "../schema/config.js";
import { buildTools } from "./tools.js";
import { plan } from "./planner.js";
import type { EvidenceRow } from "../retrieval/types.js";

type Llm = (o: {
  model: string;
  system: string;
  user: string;
}) => Promise<string>;

const SYNTHESIS_SYSTEM = `You answer questions from an internal knowledge base using
ONLY the numbered evidence provided. Cite evidence inline as [n] after each claim.
When evidence items disagree, say so explicitly and prefer the newer one, citing both.
When the evidence does not answer the question, say what is missing instead of guessing.
Be concise: a few sentences, no preamble.`;

export interface AskResult {
  answer: string;
  evidence: EvidenceRow[];
  plan: {
    tools: { name: string; query: string }[];
    reasoning: string;
    fallback: boolean;
  };
}

export type AskStage =
  | { stage: "plan"; plan: AskResult["plan"] }
  | { stage: "evidence"; tool: string; rows: EvidenceRow[] }
  | { stage: "answer"; text: string };

export async function askStream(
  pool: pg.Pool,
  question: string,
  opts: {
    project?: string;
    fixturesDir: string;
    llm: Llm;
  },
  emit: (e: AskStage) => void,
): Promise<AskResult> {
  const cfg = loadConfig();
  const tools = buildTools(pool, {
    fixturesDir: opts.fixturesDir,
    llm: opts.llm,
  });
  const { rows } = await pool.query(
    `SELECT name, description FROM projects ORDER BY name`,
  );
  const projectsCatalog = rows
    .map((r) => `- ${r.name}: ${r.description}`)
    .join("\n");

  const p = await plan(question, tools, projectsCatalog, {
    llm: opts.llm,
    model: cfg.models.planner,
  });
  emit({ stage: "plan", plan: p });

  const byName = new Map(tools.map((t) => [t.name, t]));
  const settled = await Promise.all(
    p.tools.map((t) => {
      const tool = byName.get(t.name);
      const run = tool
        ? tool
            .run({ query: t.query, project: opts.project })
            .catch(() => [] as EvidenceRow[])
        : Promise.resolve([] as EvidenceRow[]);
      return run.then((toolRows) => {
        emit({ stage: "evidence", tool: t.name, rows: toolRows });
        return toolRows;
      });
    }),
  );
  const seen = new Set<string>();
  const evidence = settled
    .flat()
    .filter((e) => {
      const k = `${e.source}:${e.sourceId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 20);

  const numbered = evidence
    .map(
      (e, i) =>
        `<evidence n="${i + 1}" source="${e.source}" url="${e.url}"` +
        `${e.recency ? ` date="${e.recency}"` : ""}>\n${e.content.slice(0, 1500)}\n</evidence>`,
    )
    .join("\n");

  const answer =
    evidence.length === 0
      ? "No evidence found for this question in the knowledge base."
      : await opts.llm({
          model: cfg.models.synthesis,
          system: SYNTHESIS_SYSTEM,
          user: `<question>${question}</question>\n${numbered}`,
        });
  emit({ stage: "answer", text: answer });

  return { answer, evidence, plan: p };
}

export async function ask(
  pool: pg.Pool,
  question: string,
  opts: {
    project?: string;
    fixturesDir: string;
    llm: Llm;
  },
): Promise<AskResult> {
  return askStream(pool, question, opts, () => {});
}
