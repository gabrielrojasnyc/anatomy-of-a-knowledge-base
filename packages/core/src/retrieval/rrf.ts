import type { RankedList, RetrievedDoc } from "./types.js";

export function parentKey(
  doc: Pick<RetrievedDoc, "source" | "sourceId">,
): string {
  return `${doc.source}:${doc.sourceId.split("#")[0]}`;
}

export interface FusedDoc {
  doc: RetrievedDoc;
  score: number;
  contributions: { list: string; rank: number; contribution: number }[];
}

export function fuse(
  lists: RankedList[],
  opts: {
    k?: number;
    weights?: Record<string, number>;
    maxPerParent?: number;
    limit?: number;
  } = {},
): FusedDoc[] {
  const k = opts.k ?? 60;
  const byId = new Map<string, FusedDoc>();
  for (const list of lists) {
    const weight = opts.weights?.[list.name] ?? 1.0;
    list.docs.forEach((doc, i) => {
      const rank = i + 1;
      const contribution = weight / (k + rank);
      const key = `${doc.source}:${doc.sourceId}`;
      const entry = byId.get(key) ?? { doc, score: 0, contributions: [] };
      entry.score += contribution;
      entry.contributions.push({ list: list.name, rank, contribution });
      byId.set(key, entry);
    });
  }
  const fused = [...byId.values()].sort((a, b) => b.score - a.score);
  const perParent = new Map<string, number>();
  const out: FusedDoc[] = [];
  for (const f of fused) {
    const parent = parentKey(f.doc);
    const seen = perParent.get(parent) ?? 0;
    if (seen >= (opts.maxPerParent ?? 3)) continue;
    perParent.set(parent, seen + 1);
    out.push(f);
    if (out.length >= (opts.limit ?? 20)) break;
  }
  return out;
}
