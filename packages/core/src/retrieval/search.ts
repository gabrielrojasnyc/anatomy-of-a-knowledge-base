import type pg from "pg";
import { loadConfig } from "../schema/config.js";
import { embedQuery } from "../models/embeddings.js";
import { ftsRetriever, vectorRetriever, projectSources } from "./retrievers.js";
import { rareTokenRetriever, recencyRetriever } from "./signals.js";
import { fuse, type FusedDoc } from "./rrf.js";
import { rerank } from "./rerank.js";
import { expandDoc } from "./expand.js";
import { codeLinks } from "./links.js";
import type { EvidenceRow, RankedList } from "./types.js";

export interface SearchTrace {
  project: string | null;
  sources: string[] | null;
  lists: { name: string; top: { sourceId: string; score: number }[] }[];
  fused: {
    sourceId: string;
    source: string;
    score: number;
    contributions: { list: string; rank: number; contribution: number }[];
  }[];
  rerank: { applied: boolean; scores: { sourceId: string; score: number }[] };
  expanded: { sourceId: string; addedChars: number }[];
}

export interface SearchResult {
  evidence: EvidenceRow[];
  trace: SearchTrace;
}

type Llm = (o: {
  model: string;
  system: string;
  user: string;
}) => Promise<string>;

export async function search(
  pool: pg.Pool,
  query: string,
  opts: {
    project?: string;
    llm?: Llm;
    rerankModel?: string;
    fixturesDir?: string;
    limit?: number;
  } = {},
): Promise<SearchResult> {
  const limit = opts.limit ?? 10;
  const sources = opts.project
    ? await projectSources(pool, opts.project)
    : null;
  if (opts.project && sources && sources.length === 0)
    throw new Error(
      `unknown project "${opts.project}" (no sources configured)`,
    );
  const scope = sources ?? undefined;
  const qvec = await embedQuery(query);

  const listPromises: Promise<RankedList>[] = [
    ftsRetriever(pool, query, { sources: scope }),
    vectorRetriever(pool, qvec, { sources: scope }),
    rareTokenRetriever(pool, query, { sources: scope }),
    recencyRetriever(pool, qvec, { sources: scope }),
  ];
  for (const s of sources ?? [])
    listPromises.push(
      vectorRetriever(pool, qvec, {
        sources: [s],
        limit: 10,
        name: `${s}-vector`,
      }),
    );
  const lists = await Promise.all(listPromises);

  const fused = fuse(lists, { limit: 20 });

  let winners: FusedDoc[];
  let rerankScores = new Map<string, number>();
  let applied = false;
  if (opts.llm && fused.length > 0) {
    const model = opts.rerankModel ?? loadConfig().models.rerank;
    const scores = await rerank(query, fused, { llm: opts.llm, model });
    if (scores) {
      applied = true;
      rerankScores = scores;
      winners = [...fused]
        .map((f, i) => ({
          f,
          i,
          s: scores.get(`${f.doc.source}:${f.doc.sourceId}`) ?? 0,
        }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, limit)
        .map((x) => x.f);
    } else {
      winners = fused.slice(0, limit);
    }
  } else {
    winners = fused.slice(0, limit);
  }

  const expanded: { sourceId: string; addedChars: number }[] = [];
  const evidence: EvidenceRow[] = [];
  for (const f of winners) {
    const content = await expandDoc(pool, f.doc, {
      fixturesDir: opts.fixturesDir,
    });
    expanded.push({
      sourceId: f.doc.sourceId,
      addedChars: content.length - f.doc.content.length,
    });
    const authors = ((f.doc.metadata.authors as string[]) ?? []).filter(
      (a) => a !== "unknown",
    );
    const links = codeLinks(f.doc.metadata, opts.fixturesDir);
    evidence.push({
      content,
      source: f.doc.source,
      sourceId: f.doc.sourceId,
      title: f.doc.title,
      url:
        (f.doc.metadata.url as string) ?? `${f.doc.source}://${f.doc.sourceId}`,
      score: applied
        ? (rerankScores.get(`${f.doc.source}:${f.doc.sourceId}`) ?? 0)
        : f.score,
      scoreKind: applied ? "reranked" : "fused",
      retrieverAgreement: f.contributions.length,
      ...(authors.length ? { authors } : {}),
      ...(links.length ? { links } : {}),
      recency: f.doc.authoredAt
        ? f.doc.authoredAt.toISOString().slice(0, 10)
        : null,
      tool: "search",
    });
  }

  return {
    evidence,
    trace: {
      project: opts.project ?? null,
      sources,
      lists: lists.map((l) => ({
        name: l.name,
        top: l.docs
          .slice(0, 10)
          .map((d) => ({ sourceId: d.sourceId, score: d.score })),
      })),
      fused: fused.map((f) => ({
        sourceId: f.doc.sourceId,
        source: f.doc.source,
        score: f.score,
        contributions: f.contributions,
      })),
      rerank: {
        applied,
        scores: [...rerankScores.entries()]
          .map(([k, score]) => ({
            sourceId: k.split(":").slice(1).join(":"),
            score,
          }))
          .sort((a, b) => b.score - a.score),
      },
      expanded,
    },
  };
}
