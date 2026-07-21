import type { DistillCtx } from "../schema/types.js";

const DISTILL_SYSTEM = `You distill internal documents for a search index.
Given a document section, reply with ONLY JSON: {"summary": "...", "key_facts": ["..."]}.
The summary is 1 to 2 sentences an engineer would search for. Key facts are the 1 to 4
concrete claims in the section: numbers, names, decisions, commands. No prose outside JSON.`;

export async function distillSection(
  ctx: DistillCtx,
  heading: string | null,
  body: string,
): Promise<{ text: string; distilled: boolean }> {
  const rawText = [heading, body].filter(Boolean).join("\n");
  if (!ctx.llm) return { text: rawText, distilled: false };
  try {
    const reply = await ctx.llm({
      model: ctx.model,
      system: DISTILL_SYSTEM,
      user: `<section heading="${heading ?? "none"}">\n${body}\n</section>`,
    });
    const parsed = JSON.parse(
      reply.replace(/```(?:json)?|```/g, "").trim(),
    ) as { summary: string; key_facts?: string[] };
    const text = [parsed.summary, ...(parsed.key_facts ?? [])].join("\n");
    return text.trim()
      ? { text, distilled: true }
      : { text: rawText, distilled: false };
  } catch (e) {
    ctx.log(`distill failed, degrading to raw text: ${e}`);
    return { text: rawText, distilled: false };
  }
}
