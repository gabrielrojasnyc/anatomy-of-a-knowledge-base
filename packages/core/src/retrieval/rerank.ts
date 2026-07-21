import type { FusedDoc } from "./rrf.js";

const SYSTEM = `You score search results for relevance to a query.
Reply with ONLY a JSON array: [{"i": <candidate index>, "score": <0 to 10>}].
10 means the candidate directly answers the query; 0 means unrelated.
A candidate that shares words with the query but answers a different question scores low.`;

export async function rerank(
  query: string,
  candidates: FusedDoc[],
  opts: {
    llm: (o: {
      model: string;
      system: string;
      user: string;
    }) => Promise<string>;
    model: string;
  },
): Promise<Map<string, number> | null> {
  const numbered = candidates
    .map(
      (c, i) =>
        `<candidate i="${i}" title="${(c.doc.title ?? "").slice(0, 80)}">\n` +
        `${c.doc.content.slice(0, 300)}\n</candidate>`,
    )
    .join("\n");
  try {
    const reply = await opts.llm({
      model: opts.model,
      system: SYSTEM,
      user: `<query>${query}</query>\n${numbered}`,
    });
    const parsed = JSON.parse(
      reply.replace(/```(?:json)?|```/g, "").trim(),
    ) as { i: number; score: number }[];
    const out = new Map<string, number>();
    for (const { i, score } of parsed) {
      const c = candidates[i];
      if (c && Number.isFinite(score))
        out.set(`${c.doc.source}:${c.doc.sourceId}`, score);
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}
