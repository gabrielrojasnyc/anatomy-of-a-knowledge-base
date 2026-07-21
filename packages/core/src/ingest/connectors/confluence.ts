import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Connector, DistilledDoc, RawItem } from "../../schema/types.js";
import { splitMarkdownSections } from "../chunk.js";
import { distillSection } from "./bucket.js";

interface Page {
  id: string;
  title: string;
  space: string;
  authors: string[];
  updatedAt: string;
  labels?: string[];
  bodyMarkdown: string;
}

export function confluenceConnector(dir: string): Connector {
  return {
    source: "confluence",
    async *discover(): AsyncIterable<RawItem> {
      for (const f of readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()) {
        const page = JSON.parse(readFileSync(join(dir, f), "utf8")) as Page;
        yield {
          sourceId: page.id,
          title: page.title,
          payload: page,
          authoredAt: new Date(page.updatedAt),
        };
      }
    },
    async distill(item, ctx): Promise<DistilledDoc[]> {
      const page = item.payload as Page;
      const sections = splitMarkdownSections(page.bodyMarkdown);
      const out: DistilledDoc[] = [];
      for (const s of sections) {
        const d = await distillSection(ctx, s.heading, s.body);
        out.push({
          source: "confluence",
          sourceId: `${page.id}#${s.index}`,
          kind: "page_section",
          title: [page.title, s.heading].filter(Boolean).join(" / "),
          content: `${page.title}\n${d.text}`,
          raw: { heading: s.heading, body: s.body },
          metadata: {
            authors: page.authors,
            url: `confluence://${page.space}/${page.id}`,
            labels: page.labels ?? [],
            sectionIndex: s.index,
            sectionCount: sections.length,
            distilled: d.distilled,
          },
          authoredAt: new Date(page.updatedAt),
        });
      }
      return out;
    },
  };
}
