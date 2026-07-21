import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Connector,
  DistillCtx,
  DistilledDoc,
  RawItem,
} from "../../schema/types.js";
import { groupBursts, scoreBurst } from "../burst.js";

interface Issue {
  key: string;
  summary: string;
  type: string;
  status: string;
  components?: string[];
  createdAt: string;
  resolvedAt?: string;
  reporter: string;
  description: string;
  comments: { author: string; at: string; body: string }[];
}

const THREAD_SYSTEM = `You distill an issue tracker thread for a search index.
Reply with ONLY JSON:
{"question": "one line an engineer would search for",
 "summary": "1 to 2 sentences",
 "resolution": "how it was resolved, or empty string if unresolved",
 "systems": ["subsystem names"], "code_refs": ["file paths or flags mentioned"]}`;

function threadTranscript(issue: Issue): string {
  return [
    `[${issue.reporter}] ${issue.description}`,
    ...issue.comments.map((c) => `[${c.author}] ${c.body}`),
  ].join("\n");
}

export function jiraConnector(
  dir: string,
  idf: Map<string, number>,
): Connector {
  return {
    source: "jira",
    async *discover(): AsyncIterable<RawItem> {
      for (const f of readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()) {
        const issue = JSON.parse(readFileSync(join(dir, f), "utf8")) as Issue;
        yield {
          sourceId: issue.key,
          title: issue.summary,
          payload: issue,
          authoredAt: new Date(issue.resolvedAt ?? issue.createdAt),
        };
      }
    },
    async distill(item, ctx: DistillCtx): Promise<DistilledDoc[]> {
      const issue = item.payload as Issue;
      const participants = [
        ...new Set([issue.reporter, ...issue.comments.map((c) => c.author)]),
      ];
      const base = {
        source: "jira",
        authoredAt: item.authoredAt ?? null,
      };
      let content: string;
      let distilled = true;
      let codeRefs: string[] = [];
      let systems: string[] = [];
      if (ctx.llm) {
        try {
          const reply = await ctx.llm({
            model: ctx.model,
            system: THREAD_SYSTEM,
            user: `<thread issue="${issue.key}" title="${issue.summary}" status="${issue.status}">\n${threadTranscript(issue)}\n</thread>`,
          });
          const t = JSON.parse(
            reply.replace(/```(?:json)?|```/g, "").trim(),
          ) as {
            question: string;
            summary: string;
            resolution: string;
            systems?: string[];
            code_refs?: string[];
          };
          codeRefs = t.code_refs ?? [];
          systems = t.systems ?? [];
          content = [
            issue.summary,
            t.question,
            t.summary,
            t.resolution,
            ...systems,
            ...codeRefs,
          ]
            .filter(Boolean)
            .join("\n");
        } catch (e) {
          ctx.log(`jira distill failed for ${issue.key}, degrading: ${e}`);
          distilled = false;
          content = `${issue.summary}\n${threadTranscript(issue)}`;
        }
      } else {
        distilled = false;
        content = `${issue.summary}\n${threadTranscript(issue)}`;
      }
      const docs: DistilledDoc[] = [
        {
          ...base,
          sourceId: issue.key,
          kind: "issue_thread",
          title: `${issue.key}: ${issue.summary}`,
          content,
          raw: issue,
          metadata: {
            authors: participants,
            url: `jira://${issue.key}`,
            status: issue.status,
            type: issue.type,
            components: issue.components ?? [],
            systems,
            code_refs: codeRefs,
            distilled,
          },
        },
      ];
      groupBursts(issue.comments).forEach((b, i) => {
        const verdict = scoreBurst(b, idf);
        if (!verdict.pass) {
          ctx.log(
            `burst ${issue.key}#b${i} filtered: ${verdict.reasons.join("; ")}`,
          );
          return;
        }
        docs.push({
          ...base,
          sourceId: `${issue.key}#b${i}`,
          kind: "comment_burst",
          title: `${issue.key} comment by ${b.author}`,
          content: `${issue.summary}\n${b.bodies.join("\n")}`,
          raw: b,
          metadata: {
            authors: [b.author],
            url: `jira://${issue.key}`,
            distilled: false,
          },
        });
      });
      return docs;
    },
  };
}
