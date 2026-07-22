import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { codeLinks } from "./links.js";
import type { EvidenceRow } from "./types.js";

/**
 * Deterministic fetch-by-key, the counterpart to search. Search returns ranked
 * guesses; get returns the one document a citation names, whole: every section
 * of a page, every comment of a thread, every line of a file. Accepts exactly
 * the strings that appear in the url field of every search result.
 */
const SCHEMES =
  "jira://HEL-482, confluence://SPACE/HEL-008, bucket://file.md, github://helios/src/path.ts";

interface Issue {
  key: string;
  summary: string;
  type: string;
  status: string;
  reporter: string;
  createdAt: string;
  resolvedAt?: string;
  description: string;
  comments: { author: string; at: string; body: string }[];
}

function row(partial: Omit<EvidenceRow, "score" | "tool">): EvidenceRow {
  return { ...partial, score: 1, tool: "get_document" };
}

async function jiraDocument(
  pool: pg.Pool,
  key: string,
  opts: { fixturesDir?: string },
): Promise<EvidenceRow> {
  const { rows } = await pool.query(
    `SELECT raw, metadata, authored_at FROM embeddings
      WHERE source = 'jira' AND source_id = $1`,
    [key],
  );
  if (rows.length === 0)
    throw new Error(`no jira document "${key}" in the store`);
  const issue = rows[0].raw as Issue;
  const links = codeLinks(
    (rows[0].metadata as Record<string, unknown>) ?? {},
    opts.fixturesDir,
  );
  const header = [
    `${issue.key}: ${issue.summary}`,
    `status: ${issue.status}  type: ${issue.type}  reporter: ${issue.reporter}` +
      `  created: ${issue.createdAt.slice(0, 10)}` +
      (issue.resolvedAt ? `  resolved: ${issue.resolvedAt.slice(0, 10)}` : ""),
  ].join("\n");
  const thread = [
    `[${issue.reporter}] ${issue.description}`,
    ...issue.comments.map(
      (c) => `[${c.author}, ${c.at.slice(0, 10)}] ${c.body}`,
    ),
  ].join("\n\n");
  return row({
    content: `${header}\n\n${thread}`,
    source: "jira",
    sourceId: issue.key,
    title: `${issue.key}: ${issue.summary}`,
    url: `jira://${issue.key}`,
    authors: [
      ...new Set([issue.reporter, ...issue.comments.map((c) => c.author)]),
    ],
    ...(links.length ? { links } : {}),
    recency: rows[0].authored_at
      ? new Date(rows[0].authored_at as string).toISOString().slice(0, 10)
      : null,
  });
}

async function sectionedDocument(
  pool: pg.Pool,
  source: "confluence" | "bucket",
  id: string,
): Promise<EvidenceRow> {
  const { rows } = await pool.query(
    `SELECT title, raw, metadata, authored_at FROM embeddings
      WHERE source = $1 AND (source_id = $2 OR source_id LIKE $2 || '#%')
      ORDER BY COALESCE((metadata->>'sectionIndex')::int, 0)`,
    [source, id],
  );
  if (rows.length === 0)
    throw new Error(`no ${source} document "${id}" in the store`);
  const pageTitle = (rows[0].title as string).split(" / ")[0];
  const body = rows
    .map((r) => {
      const raw = r.raw as { heading?: string | null; body?: string };
      return [raw.heading ? `## ${raw.heading}` : null, raw.body ?? ""]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
  const authors = [
    ...new Set(rows.flatMap((r) => (r.metadata?.authors as string[]) ?? [])),
  ].filter((a) => a !== "unknown");
  const dates = rows
    .map((r) => r.authored_at)
    .filter(Boolean)
    .map((d) => new Date(d as string).getTime());
  return row({
    content: `${pageTitle}\n\n${body}`,
    source,
    sourceId: id,
    title: pageTitle,
    url: (rows[0].metadata?.url as string) ?? `${source}://${id}`,
    ...(authors.length ? { authors } : {}),
    recency: dates.length
      ? new Date(Math.max(...dates)).toISOString().slice(0, 10)
      : null,
  });
}

function fileDocument(fixturesDir: string, rel: string): EvidenceRow {
  if (rel.includes(".."))
    throw new Error(`refusing path with ".." segments: "${rel}"`);
  let text: string;
  try {
    text = readFileSync(join(fixturesDir, "github/helios", rel), "utf8");
  } catch {
    throw new Error(`no file "${rel}" under github://helios`);
  }
  return row({
    content: `File: ${rel}\n${text}`,
    source: "github",
    sourceId: rel,
    title: rel,
    url: `github://helios/${rel}`,
    recency: null,
  });
}

async function resolveBareId(
  pool: pg.Pool,
  id: string,
  opts: { fixturesDir?: string },
): Promise<EvidenceRow> {
  const { rows } = await pool.query(
    `SELECT DISTINCT source, split_part(source_id, '#', 1) AS base
       FROM embeddings WHERE source_id = $1 OR source_id LIKE $1 || '#%'`,
    [id],
  );
  if (rows.length === 0)
    throw new Error(
      `no document found for "${id}". Pass the url field of a search result` +
        ` (${SCHEMES}). If the store is empty, run pnpm kb ingest first.`,
    );
  if (rows.length > 1)
    throw new Error(
      `"${id}" is ambiguous: ` +
        rows.map((r) => `${r.source}://${r.base}`).join(", "),
    );
  return dispatch(pool, rows[0].source as string, rows[0].base as string, opts);
}

function dispatch(
  pool: pg.Pool,
  source: string,
  id: string,
  opts: { fixturesDir?: string },
): Promise<EvidenceRow> {
  if (source === "jira") return jiraDocument(pool, id, opts);
  if (source === "confluence" || source === "bucket")
    return sectionedDocument(pool, source, id);
  if (source === "github") {
    if (!opts.fixturesDir)
      return Promise.reject(new Error("github fetch needs a fixtures dir"));
    return Promise.resolve(fileDocument(opts.fixturesDir, id));
  }
  return Promise.reject(
    new Error(`unknown source "${source}"; expected one of: ${SCHEMES}`),
  );
}

export async function getDocument(
  pool: pg.Pool,
  uri: string,
  opts: { fixturesDir?: string } = {},
): Promise<EvidenceRow> {
  const trimmed = uri.trim();
  if (trimmed.length === 0)
    throw new Error(`get_document needs a uri (${SCHEMES})`);
  const m = trimmed.match(/^([a-z]+):\/\/(.+)$/);
  if (!m) return resolveBareId(pool, trimmed.split("#")[0], opts);
  const [, scheme, rest] = m;
  if (scheme === "people")
    throw new Error(
      "people:// entries are rankings, not documents; call who_knows or search with the person's name",
    );
  if (scheme === "jira")
    return dispatch(pool, "jira", rest.split("#")[0], opts);
  if (scheme === "confluence") {
    const id = rest.split("#")[0].split("/").pop() ?? rest;
    return dispatch(pool, "confluence", id, opts);
  }
  if (scheme === "bucket")
    return dispatch(pool, "bucket", rest.split("#")[0], opts);
  if (scheme === "github") {
    const rel = rest.replace(/^helios\//, "").split("#")[0];
    return dispatch(pool, "github", rel, opts);
  }
  throw new Error(`unknown scheme "${scheme}://"; expected one of: ${SCHEMES}`);
}
