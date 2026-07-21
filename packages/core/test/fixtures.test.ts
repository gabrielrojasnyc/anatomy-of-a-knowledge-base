import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const fx = (p: string) => join(ROOT, "fixtures", p);
const CAST = new Set([
  "Maya Okafor",
  "Priya Natarajan",
  "Owen Reyes",
  "Sam Whitfield",
  "Jonah Kim",
  "Elena Petrova",
  "Gabe Rojas",
]);

const loadDir = (dir: string) =>
  readdirSync(fx(dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(fx(join(dir, f)), "utf8")));

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

describe("fixture lint", () => {
  const pages = loadDir("confluence");
  const issues = loadDir("jira");
  const codeFiles = walk(fx("github/helios")).filter((f) => f.endsWith(".ts"));
  const bucketFiles = readdirSync(fx("bucket")).filter((f) =>
    f.endsWith(".md"),
  );

  it("meets corpus minimums", () => {
    expect(pages.length).toBeGreaterThanOrEqual(20);
    expect(issues.length).toBeGreaterThanOrEqual(30);
    expect(codeFiles.length).toBeGreaterThanOrEqual(20);
    expect(bucketFiles.length).toBeGreaterThanOrEqual(8);
  });

  it("pages are well formed with known authors", () => {
    for (const p of pages) {
      for (const k of [
        "id",
        "title",
        "space",
        "authors",
        "updatedAt",
        "bodyMarkdown",
      ])
        expect(p[k], `${p.id} missing ${k}`).toBeDefined();
      for (const a of p.authors)
        expect(CAST.has(a), `${p.id} unknown author ${a}`).toBe(true);
    }
  });

  it("issues are well formed with known authors", () => {
    for (const i of issues) {
      for (const k of [
        "key",
        "summary",
        "type",
        "status",
        "createdAt",
        "reporter",
        "description",
        "comments",
      ])
        expect(i[k], `${i.key} missing ${k}`).toBeDefined();
      expect(CAST.has(i.reporter), `${i.key} unknown reporter`).toBe(true);
      for (const c of i.comments)
        expect(CAST.has(c.author), `${i.key} unknown ${c.author}`).toBe(true);
    }
  });

  it("every src/ path mentioned in prose exists in the code fixture", () => {
    const bodies = [
      ...pages.map((p: { bodyMarkdown: string }) => p.bodyMarkdown),
      ...issues.flatMap(
        (i: { description: string; comments: { body: string }[] }) => [
          i.description,
          ...i.comments.map((c) => c.body),
        ],
      ),
    ].join("\n");
    for (const m of bodies.matchAll(/src\/[\w/.-]+\.ts/g))
      expect(
        existsSync(fx(join("github/helios", m[0]))),
        `${m[0]} missing`,
      ).toBe(true);
  });

  it("golden expectations all resolve to fixtures", () => {
    const golden = JSON.parse(
      readFileSync(join(ROOT, "eval/golden.json"), "utf8"),
    );
    const pageIds = new Set(pages.map((p: { id: string }) => p.id));
    const issueKeys = new Set(issues.map((i: { key: string }) => i.key));
    expect(golden.questions.length).toBeGreaterThanOrEqual(10);
    for (const q of golden.questions) {
      for (const e of q.expect ?? []) {
        if (e.source === "confluence")
          expect(pageIds.has(e.sourceIdPrefix), `${q.id}`).toBe(true);
        if (e.source === "jira")
          expect(issueKeys.has(e.sourceIdPrefix), `${q.id}`).toBe(true);
        if (e.source === "github")
          expect(
            codeFiles.some((f) =>
              f.includes(e.sourceIdPrefix.replace("src/", "")),
            ),
            `${q.id}: ${e.sourceIdPrefix}`,
          ).toBe(true);
        if (e.source === "bucket")
          expect(bucketFiles, `${q.id}`).toContain(e.sourceIdPrefix);
      }
    }
  });
});
