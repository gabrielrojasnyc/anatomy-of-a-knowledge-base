import { describe, it, expect } from "vitest";
import { tokenize, computeIdf } from "../src/ingest/idf.js";

describe("tokenize", () => {
  it("lowercases, keeps identifiers, drops stopwords and short tokens", () => {
    expect(tokenize("Set CKPT_PREFETCH=4 for the NFS mount")).toEqual([
      "set",
      "ckpt_prefetch",
      "nfs",
      "mount",
    ]);
  });
});

describe("computeIdf", () => {
  it("matches hand-computed values", () => {
    const docs = [
      tokenize("checkpoint restore stalls"),
      tokenize("checkpoint format documentation"),
      tokenize("cafeteria menu tuesday"),
    ];
    const idf = computeIdf(docs);
    expect(idf.get("checkpoint")!.docCount).toBe(2);
    expect(idf.get("checkpoint")!.idf).toBeCloseTo(Math.log(3 / 2), 5);
    expect(idf.get("cafeteria")!.idf).toBeCloseTo(Math.log(3), 5);
  });
});
