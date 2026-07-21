import { describe, it, expect } from "vitest";
import { embedDocs, embedQuery } from "../src/models/embeddings.js";

const cosine = (a: number[], b: number[]) =>
  a.reduce((s, x, i) => s + x * b[i], 0);

describe("local embeddings", () => {
  it("produces 384-dim normalized vectors", async () => {
    const [v] = await embedDocs(["checkpoint restore stalls on NFS"]);
    expect(v).toHaveLength(384);
    expect(cosine(v, v)).toBeCloseTo(1, 3);
  });

  it("ranks paraphrase above unrelated text", async () => {
    const q = await embedQuery("restore hangs after manifest load");
    const [para, junk] = await embedDocs([
      "checkpoint stalls on the NFS mount during restore",
      "the cafeteria menu changes on Tuesdays",
    ]);
    expect(cosine(q, para)).toBeGreaterThan(cosine(q, junk));
  });
});
