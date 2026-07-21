import { tokenize } from "./idf.js";

export interface Burst {
  author: string;
  at: string;
  bodies: string[];
}

export function groupBursts(
  comments: { author: string; at: string; body: string }[],
): Burst[] {
  const out: Burst[] = [];
  for (const c of comments) {
    const last = out[out.length - 1];
    if (last && last.author === c.author) last.bodies.push(c.body);
    else out.push({ author: c.author, at: c.at, bodies: [c.body] });
  }
  return out;
}

export function scoreBurst(
  b: Burst,
  idf: Map<string, number>,
): { pass: boolean; reasons: string[] } {
  const text = b.bodies.join("\n");
  const reasons: string[] = [];
  if (text.length < 200) reasons.push(`length ${text.length} < 200`);
  const top = Math.max(0, ...tokenize(text).map((t) => idf.get(t) ?? 0));
  if (top < 4.0) reasons.push(`max idf ${top.toFixed(2)} < 4.0`);
  return { pass: reasons.length === 0, reasons };
}
