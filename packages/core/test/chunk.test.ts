import { describe, it, expect } from "vitest";
import { splitMarkdownSections, chunkTypeScript } from "../src/ingest/chunk.js";

describe("splitMarkdownSections", () => {
  it("splits on headings and keeps order", () => {
    const md =
      "intro text\n\n## Setup\nsteps here\n\n## Troubleshooting\nfix things\n";
    const s = splitMarkdownSections(md);
    expect(s.map((x) => x.heading)).toEqual([null, "Setup", "Troubleshooting"]);
    expect(s.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(s[1].body).toContain("steps here");
  });
});

describe("chunkTypeScript", () => {
  const small = `export class Foo {\n  bar(): number { return 1; }\n}\n`;
  it("keeps a small class as one class-boundary chunk", () => {
    const c = chunkTypeScript(small);
    expect(c).toHaveLength(1);
    expect(c[0].boundary).toBe("class");
  });

  it("descends to function boundaries when a class is too large", () => {
    const big =
      `export class Big {\n` +
      `  one(): string {\n${"    const x = 1;\n".repeat(20)}    return "a";\n  }\n` +
      `  two(): string {\n${"    const y = 2;\n".repeat(20)}    return "b";\n  }\n}\n`;
    const c = chunkTypeScript(big, 500);
    expect(c.length).toBeGreaterThan(1);
    expect(c.some((x) => x.boundary === "function")).toBe(true);
  });

  it("chunks plain statement files as blocks", () => {
    const flat = "const a = 1;\n".repeat(200);
    const c = chunkTypeScript(flat, 500);
    expect(c.length).toBeGreaterThan(1);
    expect(c.every((x) => x.boundary === "block")).toBe(true);
  });
});
