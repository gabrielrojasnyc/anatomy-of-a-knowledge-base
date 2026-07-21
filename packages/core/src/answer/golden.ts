import { readFileSync } from "node:fs";
import type pg from "pg";
import { search } from "../retrieval/search.js";
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
}

export interface Grade {
  id: string;
  pass: boolean;
  details: string[];
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
  let pass = true;

  if (q.expect?.length) {
    const { evidence } = await search(pool, q.question, {
      project: q.project,
      llm: opts.llm,
      fixturesDir: opts.fixturesDir,
    });
    for (const e of q.expect) {
      const hit = evidence.some(
        (r) => r.source === e.source && r.sourceId.startsWith(e.sourceIdPrefix),
      );
      if (!hit) {
        pass = false;
        details.push(`missing ${e.source}:${e.sourceIdPrefix}`);
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

  return { id: q.id, pass, details };
}
