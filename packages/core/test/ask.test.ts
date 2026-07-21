import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { getPool } from "../src/schema/db.js";
import { buildTools } from "../src/answer/tools.js";
import { plan } from "../src/answer/planner.js";
import { ask } from "../src/answer/ask.js";
import { ensureCorpus } from "./helpers.js";

const ROOT = join(import.meta.dirname, "../../..");
const pool = getPool();
const tools = buildTools(pool, { fixturesDir: join(ROOT, "fixtures") });
beforeAll(() => ensureCorpus(pool), 600_000);
afterAll(async () => {
  await pool.end();
});

describe("plan", () => {
  it("keeps only known tools and their queries", async () => {
    const llm = async () =>
      JSON.stringify({
        tools: [
          { name: "search_code", query: "HELIOS_PREFETCH_DEPTH" },
          { name: "made_up_tool", query: "x" },
        ],
        reasoning: "flag lookup",
      });
    const p = await plan("what is HELIOS_PREFETCH_DEPTH?", tools, "catalog", {
      llm,
      model: "m",
    });
    expect(p.tools).toEqual([
      { name: "search_code", query: "HELIOS_PREFETCH_DEPTH" },
    ]);
    expect(p.fallback).toBe(false);
  });

  it("falls back to search when the planner fails", async () => {
    const llm = async () => {
      throw new Error("down");
    };
    const p = await plan("anything", tools, "catalog", { llm, model: "m" });
    expect(p.tools).toEqual([{ name: "search", query: "anything" }]);
    expect(p.fallback).toBe(true);
  });

  it("falls back when the plan parses but names no known tools", async () => {
    const llm = async () =>
      JSON.stringify({
        tools: [{ name: "nonexistent", query: "x" }],
        reasoning: "bad plan",
      });
    const p = await plan("anything", tools, "catalog", { llm, model: "m" });
    expect(p.tools).toEqual([{ name: "search", query: "anything" }]);
    expect(p.fallback).toBe(true);
  });
});

describe("ask", () => {
  it("plans, executes, and synthesizes a cited answer", async () => {
    let call = 0;
    const llm = async ({ system }: { system: string }) => {
      call++;
      if (system.includes("select the best tools"))
        return JSON.stringify({
          tools: [{ name: "search", query: "checkpoint restore stalls" }],
          reasoning: "hybrid search covers it",
        });
      if (system.includes("score search results"))
        throw new Error("skip rerank");
      return "Restore stalls because prefetch depth saturates NFS [1]. Set HELIOS_PREFETCH_DEPTH=4 [2].";
    };
    const result = await ask(pool, "Why does checkpoint restore stall?", {
      project: "helios-eng",
      fixturesDir: join(ROOT, "fixtures"),
      llm,
    });
    expect(result.plan.tools[0].name).toBe("search");
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.answer).toContain("[1]");
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it("dedupes evidence that two tools both return", async () => {
    const llm = async ({ system }: { system: string }) => {
      if (system.includes("select the best tools"))
        return JSON.stringify({
          tools: [
            { name: "search_jira", query: "manifest timeout" },
            { name: "search_jira", query: "manifest timeout" },
          ],
          reasoning: "twice",
        });
      return "answer [1]";
    };
    const result = await ask(pool, "what is ERR_MANIFEST_TIMEOUT?", {
      fixturesDir: join(ROOT, "fixtures"),
      llm,
    });
    const keys = result.evidence.map((e) => `${e.source}:${e.sourceId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("askStream emits plan, per-tool evidence, then answer", async () => {
    const llm = async ({ system }: { system: string }) => {
      if (system.includes("select the best tools"))
        return JSON.stringify({
          tools: [{ name: "search_jira", query: "manifest timeout" }],
          reasoning: "jira only",
        });
      return "streamed answer [1]";
    };
    const stages: string[] = [];
    const { askStream } = await import("../src/answer/ask.js");
    const result = await askStream(
      pool,
      "what is ERR_MANIFEST_TIMEOUT?",
      {
        fixturesDir: join(ROOT, "fixtures"),
        llm,
      },
      (e) => stages.push(e.stage),
    );
    expect(stages).toEqual(["plan", "evidence", "answer"]);
    expect(result.answer).toContain("streamed answer");
  });
});
