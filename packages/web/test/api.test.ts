import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@kb/core";
import { ensureCorpus } from "../../core/test/helpers.js";
import { app, closePool } from "../src/api.js";

beforeAll(async () => {
  await ensureCorpus(getPool());
}, 600_000);
afterAll(async () => {
  await closePool();
});

describe("web api", () => {
  it("GET /api/projects lists both projects", async () => {
    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { sourceId: string }[];
    expect(rows.map((r) => r.sourceId).sort()).toEqual([
      "content",
      "helios-eng",
    ]);
  });

  it("GET /api/search returns evidence and trace", async () => {
    const res = await app.request(
      "/api/search?q=checkpoint%20restore%20stalls",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      evidence: unknown[];
      trace: { lists: unknown[] };
    };
    expect(body.evidence.length).toBeGreaterThan(0);
    expect(body.trace.lists.length).toBeGreaterThanOrEqual(4);
  });

  it("GET /api/search without q is a 400", async () => {
    const res = await app.request("/api/search");
    expect(res.status).toBe(400);
  });
});
