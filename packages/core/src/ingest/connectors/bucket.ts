import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  Connector,
  DistillCtx,
  DistilledDoc,
  RawItem,
} from "../../schema/types.js";
import { splitMarkdownSections } from "../chunk.js";
import { parseFrontMatter } from "../frontmatter.js";

const DISTILL_SYSTEM = `You distill internal documents for a search index.
Given a document section, reply with ONLY JSON: {"summary": "...", "key_facts": ["..."]}.
The summary is 1 to 2 sentences an engineer would search for. Key facts are the 1 to 4
concrete claims in the section: numbers, names, decisions, commands. No prose outside JSON.`;

function walkMd(dir: string, base: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walkMd(join(dir, e.name), base)
      : e.name.endsWith(".md")
        ? [relative(base, join(dir, e.name))]
        : [],
  );
}

async function distillSection(
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

export { distillSection };

export function bucketConnector(dir: string): Connector {
  return {
    source: "bucket",
    async *discover(): AsyncIterable<RawItem> {
      for (const rel of walkMd(dir, dir).sort()) {
        const { meta, body } = parseFrontMatter(
          readFileSync(join(dir, rel), "utf8"),
        );
        yield {
          sourceId: rel,
          title: typeof meta.title === "string" ? meta.title : rel,
          payload: { meta, body },
          authoredAt:
            typeof meta.date === "string" ? new Date(meta.date) : undefined,
        };
      }
    },
    async distill(item, ctx): Promise<DistilledDoc[]> {
      const { meta, body } = item.payload as {
        meta: Record<string, string | string[]>;
        body: string;
      };
      const sections = splitMarkdownSections(body);
      const out: DistilledDoc[] = [];
      for (const s of sections) {
        const d = await distillSection(ctx, s.heading, s.body);
        out.push({
          source: "bucket",
          sourceId: `${item.sourceId}#${s.index}`,
          kind: "doc_section",
          title: [item.title, s.heading].filter(Boolean).join(" / "),
          content: `${item.title}\n${d.text}`,
          raw: { heading: s.heading, body: s.body },
          metadata: {
            authors: [meta.author ?? "unknown"].flat(),
            url: `bucket://${item.sourceId}`,
            labels: [meta.tags ?? []].flat(),
            sectionIndex: s.index,
            sectionCount: sections.length,
            distilled: d.distilled,
          },
          authoredAt: item.authoredAt ?? null,
        });
      }
      return out;
    },
  };
}
