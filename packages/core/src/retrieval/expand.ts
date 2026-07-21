import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import type { RetrievedDoc } from "./types.js";

async function neighborSections(
  pool: pg.Pool,
  doc: RetrievedDoc,
): Promise<string[]> {
  const [base, idxStr] = doc.sourceId.split("#");
  const idx = Number(idxStr);
  if (!Number.isFinite(idx)) return [];
  const ids = [`${base}#${idx - 1}`, `${base}#${idx + 1}`];
  const { rows } = await pool.query(
    `SELECT raw, source_id FROM embeddings WHERE source = $1 AND source_id = ANY($2)`,
    [doc.source, ids],
  );
  const sorted = rows.sort((a, b) => {
    const aNum = Number(a.source_id.split("#")[1]);
    const bNum = Number(b.source_id.split("#")[1]);
    return aNum - bNum;
  });
  return sorted
    .map((r) => {
      const raw = r.raw as { heading?: string | null; body?: string } | null;
      return [raw?.heading, raw?.body].filter(Boolean).join("\n");
    })
    .filter((s) => s.length > 0);
}

export async function expandDoc(
  pool: pg.Pool,
  doc: RetrievedDoc,
  opts: { fixturesDir?: string } = {},
): Promise<string> {
  try {
    if (doc.kind === "page_section" || doc.kind === "doc_section") {
      const neighbors = await neighborSections(pool, doc);
      if (neighbors.length === 0) return doc.content;
      return `${doc.content}\n\n[surrounding context]\n${neighbors.join("\n\n")}`;
    }
    if (doc.kind === "issue_thread") {
      const { rows } = await pool.query(
        `SELECT raw FROM embeddings WHERE source = $1 AND source_id = $2`,
        [doc.source, doc.sourceId],
      );
      const raw = rows[0]?.raw as {
        comments?: { author: string; body: string }[];
      } | null;
      const comments = raw?.comments ?? [];
      if (comments.length === 0) return doc.content;
      const longest = [...comments].sort(
        (a, b) => b.body.length - a.body.length,
      )[0];
      const last = comments[comments.length - 1];
      const picks = [...new Set([longest, last])];
      return (
        `${doc.content}\n\n[thread detail]\n` +
        picks.map((c) => `${c.author}: ${c.body}`).join("\n")
      );
    }
    if (doc.kind === "code_chunk" && opts.fixturesDir) {
      const rel = (doc.metadata.path as string) ?? doc.sourceId.split("#")[0];
      if (rel.includes("..")) return doc.content;
      const m = doc.sourceId.match(/#(\d+)-(\d+)$/);
      if (!m) return doc.content;
      const lines = readFileSync(
        join(opts.fixturesDir, "github/helios", rel),
        "utf8",
      ).split("\n");
      const start = Math.max(0, Number(m[1]) - 1 - 10);
      const end = Math.min(lines.length, Number(m[2]) + 10);
      return `File: ${rel} lines ${start + 1} to ${end}\n${lines.slice(start, end).join("\n")}`;
    }
    return doc.content;
  } catch {
    return doc.content;
  }
}
