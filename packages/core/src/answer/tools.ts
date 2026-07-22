import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type pg from "pg";
import { embedQuery } from "../models/embeddings.js";
import { ftsRetriever, vectorRetriever } from "../retrieval/retrievers.js";
import { fuse } from "../retrieval/rrf.js";
import { search } from "../retrieval/search.js";
import { expandDoc } from "../retrieval/expand.js";
import { getDocument } from "../retrieval/get.js";
import { codeLinks } from "../retrieval/links.js";
import type { EvidenceRow } from "../retrieval/types.js";

type Llm = (o: {
  model: string;
  system: string;
  user: string;
}) => Promise<string>;

/**
 * Each tool declares exactly the parameters it reads: the MCP server builds
 * its input schema from this list, so the schema an agent sees is the contract
 * the code enforces. A tool that ignores a parameter must not advertise it.
 */
export interface ToolParam {
  name: "query" | "project" | "limit" | "uri";
  required?: boolean;
  max?: number;
  description: string;
}

export interface ToolArgs {
  query?: string;
  project?: string;
  limit?: number;
  uri?: string;
}

export interface Tool {
  name: string;
  description: string;
  params: ToolParam[];
  run(args: ToolArgs): Promise<EvidenceRow[]>;
}

const QUERY: ToolParam = {
  name: "query",
  required: true,
  description: "What to look for",
};

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
  opts: { fixturesDir: string; limit?: number },
): Promise<EvidenceRow[]> {
  const qvec = await embedQuery(query);
  const lists = await Promise.all([
    ftsRetriever(pool, query, { sources: [source], limit: 20 }),
    vectorRetriever(pool, qvec, { sources: [source], limit: 20 }),
  ]);
  const out: EvidenceRow[] = [];
  for (const f of fuse(lists, { limit: opts.limit ?? 5 })) {
    const authors = ((f.doc.metadata.authors as string[]) ?? []).filter(
      (a) => a !== "unknown",
    );
    const links = codeLinks(f.doc.metadata, opts.fixturesDir);
    out.push({
      content: await expandDoc(pool, f.doc, { fixturesDir: opts.fixturesDir }),
      source: f.doc.source,
      sourceId: f.doc.sourceId,
      title: f.doc.title,
      url:
        (f.doc.metadata.url as string) ?? `${f.doc.source}://${f.doc.sourceId}`,
      score: f.score,
      scoreKind: "fused",
      retrieverAgreement: f.contributions.length,
      ...(authors.length ? { authors } : {}),
      ...(links.length ? { links } : {}),
      recency: f.doc.authoredAt
        ? f.doc.authoredAt.toISOString().slice(0, 10)
        : null,
      tool: `search_${source}`,
    });
  }
  return out;
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
        "Hybrid search across all sources in scope: use for most questions. " +
        "Follow any result's url with get_document to read the full artifact.",
      params: [
        QUERY,
        { name: "project", description: "Optional project scope" },
        { name: "limit", max: 20, description: "Max rows (default 10)" },
      ],
      run: ({ query, project, limit }) =>
        search(pool, query ?? "", {
          project,
          limit,
          llm: opts.llm,
          fixturesDir: opts.fixturesDir,
        }).then((r) => r.evidence),
    },
    {
      name: "search_confluence",
      description: "Wiki only: runbooks, RFCs, onboarding, policy pages.",
      params: [
        QUERY,
        { name: "limit", max: 20, description: "Max rows (default 5)" },
      ],
      run: ({ query, limit }) =>
        sourceSearch(pool, "confluence", query ?? "", {
          fixturesDir: opts.fixturesDir,
          limit,
        }),
    },
    {
      name: "search_jira",
      description:
        "Issue tracker only: incidents, bugs, decisions and their resolutions.",
      params: [
        QUERY,
        { name: "limit", max: 20, description: "Max rows (default 5)" },
      ],
      run: ({ query, limit }) =>
        sourceSearch(pool, "jira", query ?? "", {
          fixturesDir: opts.fixturesDir,
          limit,
        }),
    },
    {
      name: "search_code",
      description:
        "Exact text search over the Helios codebase: flags, error strings, function names. Prefix with re: for regex.",
      params: [
        QUERY,
        { name: "limit", max: 50, description: "Max rows (default 50)" },
      ],
      run: async ({ query = "", limit }) => {
        const cap = limit ?? 50;
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
        let matched = 0;
        for (const rel of walk(codeRoot, codeRoot).sort()) {
          const lines = readFileSync(join(codeRoot, rel), "utf8").split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i])) continue;
            matched++;
            if (out.length >= cap) continue;
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
        if (matched > out.length)
          out.push({
            content: `matched ${matched} lines; showing the first ${out.length}. Narrow the query or raise limit (max 50).`,
            source: "meta",
            sourceId: "truncated",
            title: "match limit reached",
            url: "meta://truncated",
            score: 0,
            recency: null,
            tool: "search_code",
          });
        return out;
      },
    },
    {
      name: "get_document",
      description:
        "Fetch the complete document behind any result url: the whole JIRA thread with every comment, " +
        "all sections of a wiki page or doc, or an entire source file. " +
        "Use it to follow a citation instead of re-searching.",
      params: [
        {
          name: "uri",
          required: true,
          description:
            "The url field of any result (jira://HEL-482, confluence://HELIOS/HEL-008, " +
            "bucket://file.md, github://helios/src/path.ts) or a bare id like HEL-482",
        },
      ],
      run: ({ uri, query }) =>
        getDocument(pool, uri ?? query ?? "", {
          fixturesDir: opts.fixturesDir,
        }).then((r) => [r]),
    },
    {
      name: "who_knows",
      description:
        "Find people with demonstrated expertise on a topic, ranked by evidence.",
      params: [{ ...QUERY, description: "Topic to find experts on" }],
      run: async ({ query = "" }) => {
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
      name: "status",
      description:
        "Corpus readiness: per-source document counts, distilled fraction, newest document date. " +
        "Call this when results look empty or stale: an empty store means nothing was ingested, not that no evidence exists.",
      params: [],
      run: async () => {
        const { rows } = await pool.query(
          `SELECT source, count(*)::int AS docs,
                  round(avg((metadata->>'distilled')::boolean::int) * 100)::int AS distilled_pct,
                  max(authored_at) AS newest
             FROM embeddings GROUP BY source ORDER BY source`,
        );
        if (rows.length === 0)
          return [
            {
              content:
                "empty store: nothing ingested yet. Run pnpm kb ingest from the repo root, then retry.",
              source: "meta",
              sourceId: "status",
              title: "empty store",
              url: "status://empty",
              score: 0,
              recency: null,
              tool: "status",
            },
          ];
        return rows.map((r) => ({
          content:
            `${r.source}: ${r.docs} docs, ${r.distilled_pct ?? 0}% distilled` +
            (r.newest
              ? `, newest ${new Date(r.newest as string).toISOString().slice(0, 10)}`
              : ""),
          source: "meta",
          sourceId: `status:${r.source}`,
          title: r.source as string,
          url: `status://${r.source}`,
          score: 1,
          recency: null,
          tool: "status",
        }));
      },
    },
    {
      name: "list_projects",
      description:
        "List the available projects and which sources each one scopes to.",
      params: [],
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
