import { readFileSync } from "node:fs";
import type pg from "pg";
import { search } from "../retrieval/search.js";
import { getDocument } from "../retrieval/get.js";
import { buildTools } from "./tools.js";

type Llm = (o: {
  model: string;
  system: string;
  user: string;
}) => Promise<string>;

export interface GoldenQuestion {
  id: string;
  project: string;
  question: string;
  note?: string;
  expect?: { source: string; sourceIdPrefix: string }[];
  expectPeople?: string[];
  /** The corpus cannot answer this; retrieval must not pretend otherwise. */
  expectAbstain?: boolean;
  /**
   * A two-step trajectory graded on terminal evidence: search must surface
   * the `from` row, and following that row's links through get_document must
   * land on the terminal artifact. This is the agent's investigation shape
   * (search, then get) tested end to end, not stage by stage.
   */
  expectHop?: {
    from: { source: string; sourceIdPrefix: string };
    terminal: { source: string; contentIncludes: string };
  };
}

export interface Grade {
  id: string;
  pass: boolean;
  /** True when the question needs a capability this run lacks (e.g. rerank). */
  skipped?: boolean;
  details: string[];
  /** 1/rank per expected hit, 0 when absent. Feeds the MRR trend line. */
  reciprocalRanks?: number[];
}

export function loadGolden(path: string): GoldenQuestion[] {
  return (
    JSON.parse(readFileSync(path, "utf8")) as { questions: GoldenQuestion[] }
  ).questions;
}

export async function gradeQuestion(
  pool: pg.Pool,
  q: GoldenQuestion,
  opts: { fixturesDir: string; llm?: Llm },
): Promise<Grade> {
  const details: string[] = [];
  const reciprocalRanks: number[] = [];
  let pass = true;

  if (q.expectAbstain) {
    // Raw fusion always fills its row budget, so it cannot say "nothing
    // relevant here"; only a scoring layer can. Grade abstention against
    // rerank: every survivor must score at or below the relevance floor.
    if (!opts.llm)
      return {
        id: q.id,
        pass: true,
        skipped: true,
        details: ["skipped: abstention grading needs rerank (--live)"],
      };
    const { evidence } = await search(pool, q.question, {
      project: q.project,
      llm: opts.llm,
      fixturesDir: opts.fixturesDir,
    });
    const reranked = evidence.filter((r) => r.scoreKind === "reranked");
    if (evidence.length > 0 && reranked.length === 0)
      return {
        id: q.id,
        pass: true,
        skipped: true,
        details: ["skipped: rerank did not run"],
      };
    const worst = reranked.reduce((a, r) => (r.score > a.score ? r : a), {
      score: -1,
      sourceId: "(none)",
    } as { score: number; sourceId: string });
    if (worst.score > 3) {
      pass = false;
      details.push(
        `rerank scored ${worst.sourceId} ${worst.score}/10 for an unanswerable question`,
      );
    } else {
      details.push(`all ${reranked.length} rows at or below 3/10`);
    }
  }

  if (q.expectHop) {
    // Links come from distillation's code_refs; a raw-text corpus has none,
    // so probe for the capability before grading against it.
    const { rows: cap } = await pool.query(
      `SELECT 1 FROM embeddings
        WHERE source = 'jira' AND jsonb_array_length(metadata->'code_refs') > 0
        LIMIT 1`,
    );
    if (cap.length === 0)
      return {
        id: q.id,
        pass: true,
        skipped: true,
        details: [
          "skipped: no code_refs in store (hop needs a distilled corpus)",
        ],
      };
    const { evidence } = await search(pool, q.question, {
      project: q.project,
      llm: opts.llm,
      fixturesDir: opts.fixturesDir,
    });
    const { from, terminal } = q.expectHop;
    const start = evidence.find(
      (r) =>
        r.source === from.source && r.sourceId.startsWith(from.sourceIdPrefix),
    );
    if (!start) {
      pass = false;
      details.push(
        `hop start ${from.source}:${from.sourceIdPrefix} not surfaced`,
      );
    } else if (!start.links?.length) {
      pass = false;
      details.push(`${start.sourceId} surfaced without links`);
    } else {
      let landed: string | null = null;
      for (const link of start.links) {
        try {
          const doc = await getDocument(pool, link, {
            fixturesDir: opts.fixturesDir,
          });
          if (
            doc.source === terminal.source &&
            doc.content.includes(terminal.contentIncludes)
          ) {
            landed = link;
            break;
          }
        } catch {
          // A dead link is a grading failure, not a crash: fall through.
        }
      }
      if (landed) {
        details.push(
          `${start.sourceId} -> ${landed} contains "${terminal.contentIncludes}"`,
        );
      } else {
        pass = false;
        details.push(
          `no link from ${start.sourceId} reached ${terminal.source} containing "${terminal.contentIncludes}"`,
        );
      }
    }
  }

  if (q.expect?.length) {
    const { evidence } = await search(pool, q.question, {
      project: q.project,
      llm: opts.llm,
      fixturesDir: opts.fixturesDir,
    });
    for (const e of q.expect) {
      const rank = evidence.findIndex(
        (r) => r.source === e.source && r.sourceId.startsWith(e.sourceIdPrefix),
      );
      if (rank === -1) {
        pass = false;
        reciprocalRanks.push(0);
        details.push(`missing ${e.source}:${e.sourceIdPrefix}`);
      } else {
        reciprocalRanks.push(1 / (rank + 1));
        details.push(`${e.source}:${e.sourceIdPrefix} at rank ${rank + 1}`);
      }
    }
  }

  if (q.expectPeople?.length) {
    const tools = buildTools(pool, { fixturesDir: opts.fixturesDir });
    const people = await tools
      .find((t) => t.name === "who_knows")!
      .run({
        query: q.question,
      });
    const top3 = people.slice(0, 3).map((p) => p.sourceId);
    for (const person of q.expectPeople) {
      if (!top3.includes(person)) {
        pass = false;
        details.push(`${person} not in top 3`);
      }
    }
  }

  return { id: q.id, pass, details, reciprocalRanks };
}
