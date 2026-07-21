import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Connector, DistilledDoc, RawItem } from "../../schema/types.js";
import { chunkTypeScript } from "../chunk.js";

function walkTs(dir: string, base: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walkTs(join(dir, e.name), base)
      : e.name.endsWith(".ts")
        ? [relative(base, join(dir, e.name))]
        : [],
  );
}

export function githubConnector(dir: string, repo: string): Connector {
  return {
    source: "github",
    async *discover(): AsyncIterable<RawItem> {
      for (const rel of walkTs(dir, dir).sort()) {
        yield {
          sourceId: rel,
          title: rel,
          payload: readFileSync(join(dir, rel), "utf8"),
          authoredAt: statSync(join(dir, rel)).mtime,
        };
      }
    },
    async distill(item): Promise<DistilledDoc[]> {
      const code = item.payload as string;
      return chunkTypeScript(code).map((c) => ({
        source: "github",
        sourceId: `${item.sourceId}#${c.startLine}-${c.endLine}`,
        kind: "code_chunk" as const,
        title: `${item.sourceId}:${c.startLine}`,
        content: `File: ${item.sourceId} (${repo})\n${c.text}`,
        raw: {
          startLine: c.startLine,
          endLine: c.endLine,
          boundary: c.boundary,
        },
        metadata: {
          authors: [],
          url: `github://${repo}/${item.sourceId}#L${c.startLine}`,
          path: item.sourceId,
          boundary: c.boundary,
          distilled: false,
        },
        authoredAt: item.authoredAt ?? null,
      }));
    },
  };
}
