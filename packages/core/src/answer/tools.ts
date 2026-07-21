import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type pg from "pg";
import { embedQuery } from "../models/embeddings.js";
import { ftsRetriever, vectorRetriever } from "../retrieval/retrievers.js";
import { fuse } from "../retrieval/rrf.js";
import { search } from "../retrieval/search.js";
import type { EvidenceRow } from "../retrieval/types.js";

type Llm = (o: {
  model: string;
  system: string;
  user: string;
}) => Promise<string>;

export interface Tool {
  name: string;
  description: string;
  run(args: { query: string; project?: string }): Promise<EvidenceRow[]>;
}

function walk(dir: string, base: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name), base)
      : e.name.endsWith(".ts")
        ? [relative(base, join(dir, e.name))]
        : [],
  );
}

async function sourceSearch(
  pool: pg.Pool,
  source: string,
  query: string,
): Promise<EvidenceRow[]> {
  const qvec = await embedQuery(query);
  const lists = await Promise.all([
    ftsRetriever(pool, query, { sources: [source], limit: 20 }),
    vectorRetriever(pool, qvec, { sources: [source], limit: 20 }),
  ]);
  return fuse(lists, { limit: 5 }).map((f) => ({
    content: f.doc.content,
    source: f.doc.source,
    sourceId: f.doc.sourceId,
    title: f.doc.title,
    url:
      (f.doc.metadata.url as string) ?? `${f.doc.source}://${f.doc.sourceId}`,
    score: f.score,
    recency: f.doc.authoredAt
      ? f.doc.authoredAt.toISOString().slice(0, 10)
      : null,
    tool: `search_${source}`,
  }));
}

export function buildTools(
  pool: pg.Pool,
  opts: { fixturesDir: string; llm?: Llm },
): Tool[] {
  const codeRoot = join(opts.fixturesDir, "github/helios");
  return [
    {
      name: "search",
      description:
        "Hybrid search across all sources in scope: use for most questions.",
      run: ({ query, project }) =>
        search(pool, query, {
          project,
          llm: opts.llm,
          fixturesDir: opts.fixturesDir,
        }).then((r) => r.evidence),
    },
    {
      name: "search_confluence",
      description: "Wiki only: runbooks, RFCs, onboarding, policy pages.",
      run: ({ query }) => sourceSearch(pool, "confluence", query),
    },
    {
      name: "search_jira",
      description:
        "Issue tracker only: incidents, bugs, decisions and their resolutions.",
      run: ({ query }) => sourceSearch(pool, "jira", query),
    },
    {
      name: "search_code",
      description:
        "Exact text search over the Helios codebase: flags, error strings, function names. Prefix with re: for regex.",
      run: async ({ query }) => {
        const raw = query.startsWith("re:") ? query.slice(3) : null;
        let re: RegExp;
        if (raw !== null) {
          try {
            re = new RegExp(raw, "i");
          } catch {
            re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          }
        } else {
          re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        }
        const out: EvidenceRow[] = [];
        for (const rel of walk(codeRoot, codeRoot).sort()) {
          if (out.length >= 50) break;
          const lines = readFileSync(join(codeRoot, rel), "utf8").split("\n");
          for (let i = 0; i < lines.length && out.length < 50; i++) {
            if (!re.test(lines[i])) continue;
            const ctx = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
            out.push({
              content: ctx,
              source: "github",
              sourceId: `${rel}:${i + 1}`,
              title: rel,
              url: `github://helios/${rel}#L${i + 1}`,
              score: 1,
              recency: null,
              tool: "search_code",
            });
          }
        }
        return out;
      },
    },
    {
      name: "who_knows",
      description:
        "Find people with demonstrated expertise on a topic, ranked by evidence.",
      run: async ({ query }) => {
        const qvec = await embedQuery(query);
        const lists = await Promise.all([
          ftsRetriever(pool, query, { limit: 30 }),
          vectorRetriever(pool, qvec, { limit: 30 }),
        ]);
        const people = new Map<string, { weight: number; docs: number }>();
        for (const f of fuse(lists, { limit: 30, maxPerParent: 3 })) {
          for (const a of (f.doc.metadata.authors as string[]) ?? []) {
            if (a === "unknown") continue;
            const p = people.get(a) ?? { weight: 0, docs: 0 };
            p.weight += f.score;
            p.docs += 1;
            people.set(a, p);
          }
        }
        return [...people.entries()]
          .sort((a, b) => b[1].weight - a[1].weight)
          .slice(0, 5)
          .map(([person, p]) => ({
            content: `${person} (${p.docs} docs)`,
            source: "people",
            sourceId: person,
            title: person,
            url: `people://${encodeURIComponent(person)}`,
            score: p.weight,
            recency: null,
            tool: "who_knows",
          }));
      },
    },
    {
      name: "list_projects",
      description:
        "List the available projects and which sources each one scopes to.",
      run: async () => {
        const { rows } = await pool.query(
          `SELECT p.name, p.description, array_agg(ps.source ORDER BY ps.source) AS sources
             FROM projects p LEFT JOIN project_sources ps ON ps.project = p.name
            GROUP BY p.name, p.description ORDER BY p.name`,
        );
        return rows.map((r) => ({
          content: `${r.name}: ${r.description} [sources: ${(r.sources ?? []).join(", ")}]`,
          source: "projects",
          sourceId: r.name as string,
          title: r.name as string,
          url: `project://${r.name}`,
          score: 1,
          recency: null,
          tool: "list_projects",
        }));
      },
    },
  ];
}
