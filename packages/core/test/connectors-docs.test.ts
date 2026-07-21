import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { bucketConnector } from "../src/ingest/connectors/bucket.js";
import { confluenceConnector } from "../src/ingest/connectors/confluence.js";
import type { DistillCtx, RawItem } from "../src/schema/types.js";

const ROOT = join(import.meta.dirname, "../../..");
const noop = () => {};
const mockLLM: DistillCtx = {
  model: "test",
  log: noop,
  llm: async () =>
    JSON.stringify({ summary: "a summary", key_facts: ["fact one"] }),
};
const brokenLLM: DistillCtx = {
  model: "test",
  log: noop,
  llm: async () => {
    throw new Error("down");
  },
};

async function firstItem(c: {
  discover(): AsyncIterable<RawItem>;
}): Promise<RawItem> {
  for await (const item of c.discover()) return item;
  throw new Error("no items");
}

describe("bucket connector", () => {
  const c = bucketConnector(join(ROOT, "fixtures/bucket"));
  it("discovers markdown with front matter metadata", async () => {
    const item = await firstItem(c);
    expect(item.sourceId).toMatch(/\.md$/);
    expect(item.title.length).toBeGreaterThan(0);
  });
  it("distills one doc per section with normalized content", async () => {
    const item = await firstItem(c);
    const docs = await c.distill(item, mockLLM);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0].source).toBe("bucket");
    expect(docs[0].sourceId).toBe(`${item.sourceId}#0`);
    expect(docs[0].content).toContain("a summary");
    expect(docs[0].metadata.distilled).toBe(true);
  });
  it("degrades to raw text when the LLM fails", async () => {
    const item = await firstItem(c);
    const docs = await c.distill(item, brokenLLM);
    expect(docs[0].metadata.distilled).toBe(false);
    expect(docs[0].content.length).toBeGreaterThan(0);
  });
});

describe("confluence connector", () => {
  const c = confluenceConnector(join(ROOT, "fixtures/confluence"));
  it("prepends the page title to section content", async () => {
    const item = await firstItem(c);
    const docs = await c.distill(item, mockLLM);
    expect(docs[0].title).toContain(item.title);
    expect(docs[0].content.startsWith(item.title)).toBe(true);
    expect(docs[0].metadata.sectionCount).toBe(docs.length);
  });
});
