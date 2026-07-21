import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { githubConnector } from "../src/ingest/connectors/github.js";
import { jiraConnector } from "../src/ingest/connectors/jira.js";
import { groupBursts, scoreBurst } from "../src/ingest/burst.js";
import type { DistillCtx } from "../src/schema/types.js";

const ROOT = join(import.meta.dirname, "../../..");
const noop = () => {};
const threadJSON = JSON.stringify({
  question: "Why does restore stall after manifest load?",
  summary: "Prefetch depth 16 saturates NFS.",
  resolution: "Set HELIOS_PREFETCH_DEPTH=4.",
  systems: ["checkpoint", "NFS"],
  code_refs: ["src/checkpoint/loader.ts"],
});
const mockLLM: DistillCtx = {
  model: "t",
  log: noop,
  llm: async () => threadJSON,
};

describe("github connector", () => {
  const c = githubConnector(join(ROOT, "fixtures/github/helios"), "helios");
  it("emits code chunks with path-anchored ids and no LLM", async () => {
    for await (const item of c.discover()) {
      const docs = await c.distill(item, { model: "t", log: noop });
      expect(docs.length).toBeGreaterThan(0);
      expect(docs[0].kind).toBe("code_chunk");
      expect(docs[0].sourceId).toMatch(/^src\/.+#\d+-\d+$/);
      expect(docs[0].content).toContain("File: ");
      return;
    }
  });
});

describe("bursts", () => {
  const comments = [
    { author: "A", at: "2026-01-01T10:00:00Z", body: "short ack" },
    { author: "B", at: "2026-01-01T10:05:00Z", body: "x".repeat(150) },
    {
      author: "B",
      at: "2026-01-01T10:06:00Z",
      body:
        "the ckpt_prefetch flag controls parallel shard fetches and " +
        "y".repeat(160),
    },
    { author: "A", at: "2026-01-01T10:10:00Z", body: "thanks!" },
  ];
  it("groups consecutive same-author runs", () => {
    const bursts = groupBursts(comments);
    expect(bursts.map((b) => b.author)).toEqual(["A", "B", "A"]);
    expect(bursts[1].bodies).toHaveLength(2);
  });
  it("passes only long bursts containing a rare token", () => {
    const idf = new Map([["ckpt_prefetch", 5.1]]);
    const [a, b, a2] = groupBursts(comments);
    expect(scoreBurst(b, idf).pass).toBe(true);
    expect(scoreBurst(a, idf).pass).toBe(false);
    expect(scoreBurst(a2, idf).pass).toBe(false);
  });
});

describe("jira connector", () => {
  it("emits one thread doc plus qualifying bursts", async () => {
    const idf = new Map([
      ["prefetch", 4.5],
      ["nfs", 4.2],
    ]);
    const c = jiraConnector(join(ROOT, "fixtures/jira"), idf);
    for await (const item of c.discover()) {
      if (item.sourceId !== "HEL-482") continue;
      const docs = await c.distill(item, mockLLM);
      const thread = docs.find((d) => d.kind === "issue_thread")!;
      expect(thread.sourceId).toBe("HEL-482");
      expect(thread.content).toContain("Why does restore stall");
      expect(thread.content).toContain("HELIOS_PREFETCH_DEPTH=4");
      expect(thread.metadata.code_refs).toContain("src/checkpoint/loader.ts");
      const bursts = docs.filter((d) => d.kind === "comment_burst");
      for (const b of bursts) expect(b.content).toContain(item.title);
      return;
    }
  });
});
