import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Connector, DistilledDoc, RawItem } from "../../schema/types.js";
import { splitMarkdownSections } from "../chunk.js";
import { parseFrontMatter } from "../frontmatter.js";
import { distillSection } from "../distill.js";

function walkMd(dir: string, base: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walkMd(join(dir, e.name), base)
      : e.name.endsWith(".md")
        ? [relative(base, join(dir, e.name))]
        : [],
  );
}

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
