import { describe, it, expect } from "vitest";
import { fuse, parentKey } from "../src/retrieval/rrf.js";
import type { RankedList, RetrievedDoc } from "../src/retrieval/types.js";

const doc = (source: string, sourceId: string): RetrievedDoc => ({
  id: 0,
  source,
  sourceId,
  kind: "k",
  title: null,
  content: sourceId,
  metadata: {},
  authoredAt: null,
  score: 1,
});
const list = (name: string, ids: [string, string][]): RankedList => ({
  name,
  docs: ids.map(([s, i]) => doc(s, i)),
});

describe("parentKey", () => {
  it("strips the fragment", () => {
    expect(parentKey(doc("confluence", "HEL-001#2"))).toBe(
      "confluence:HEL-001",
    );
    expect(parentKey(doc("jira", "HEL-482"))).toBe("jira:HEL-482");
  });
});

describe("fuse", () => {
  it("matches the hand-computed RRF table", () => {
    const lists = [
      list("a", [
        ["x", "D1"],
        ["x", "D2"],
        ["x", "D3"],
      ]),
      list("b", [
        ["x", "D2"],
        ["x", "D1"],
      ]),
    ];
    const out = fuse(lists);
    // D1: 1/61 + 1/62 = 0.0325222; D2: 1/62 + 1/61 = same; D3: 1/63.
    // Ties broken by first appearance; D1 leads list a.
    expect(out[0].doc.sourceId).toBe("D1");
    expect(out[0].score).toBeCloseTo(1 / 61 + 1 / 62, 6);
    expect(out[2].doc.sourceId).toBe("D3");
    expect(out[2].score).toBeCloseTo(1 / 63, 6);
    expect(out[0].contributions).toHaveLength(2);
    expect(out[0].contributions[0]).toEqual({
      list: "a",
      rank: 1,
      contribution: 1 / 61,
    });
  });

  it("applies per-list weights", () => {
    const lists = [list("a", [["x", "D1"]]), list("b", [["x", "D2"]])];
    const out = fuse(lists, { weights: { b: 2 } });
    expect(out[0].doc.sourceId).toBe("D2");
    expect(out[0].score).toBeCloseTo(2 / 61, 6);
  });

  it("caps results per parent and keeps the best representative first", () => {
    const lists = [
      list("a", [
        ["c", "P#0"],
        ["c", "P#1"],
        ["c", "P#2"],
        ["c", "P#3"],
        ["c", "Q#0"],
      ]),
    ];
    const out = fuse(lists, { maxPerParent: 3 });
    const fromP = out.filter((f) => parentKey(f.doc) === "c:P");
    expect(fromP).toHaveLength(3);
    expect(fromP[0].doc.sourceId).toBe("P#0");
    expect(out.some((f) => f.doc.sourceId === "Q#0")).toBe(true);
  });
});
