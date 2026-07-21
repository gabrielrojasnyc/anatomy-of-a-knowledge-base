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

export async function ask(
  pool: pg.Pool,
  question: string,
  opts: {
    project?: string;
    fixturesDir: string;
    llm: Llm;
  },
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

  const byName = new Map(tools.map((t) => [t.name, t]));
  const settled = await Promise.all(
    p.tools.map((t) =>
      byName
        .get(t.name)!
        .run({ query: t.query, project: opts.project })
        .catch(() => [] as EvidenceRow[]),
    ),
  );
  const evidence = settled.flat().slice(0, 20);

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

  return { answer, evidence, plan: p };
}
