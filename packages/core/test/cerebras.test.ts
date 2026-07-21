import { describe, it, expect, vi, afterEach } from "vitest";
import { chat, chatJSON, CerebrasError } from "../src/models/cerebras.js";

const ok = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});
const fail = (status: number) => ({
  ok: false,
  status,
  text: async () => "err",
});

afterEach(() => vi.unstubAllGlobals());

describe("cerebras client", () => {
  it("returns content on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok("hello")));
    expect(
      await chat({ model: "m", system: "s", user: "u", apiKey: "k" }),
    ).toBe("hello");
  });

  it("retries on 429 then succeeds", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(fail(429))
      .mockResolvedValue(ok("hi"));
    vi.stubGlobal("fetch", f);
    expect(
      await chat({
        model: "m",
        system: "s",
        user: "u",
        apiKey: "k",
        retryDelayMs: 1,
      }),
    ).toBe("hi");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("throws CerebrasError after 3 failures", async () => {
    const f = vi.fn().mockResolvedValue(fail(500));
    vi.stubGlobal("fetch", f);
    await expect(
      chat({
        model: "m",
        system: "s",
        user: "u",
        apiKey: "k",
        retryDelayMs: 1,
      }),
    ).rejects.toBeInstanceOf(CerebrasError);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("chatJSON strips fences and validates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ok('```json\n{"a":1}\n```')),
    );
    const out = await chatJSON({
      model: "m",
      system: "s",
      user: "u",
      apiKey: "k",
      validate: (x: unknown) => x as { a: number },
    });
    expect(out.a).toBe(1);
  });

  it("chatJSON repairs invalid JSON with one extra call", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(ok("not json"))
      .mockResolvedValue(ok('{"a":2}'));
    vi.stubGlobal("fetch", f);
    const out = await chatJSON({
      model: "m",
      system: "s",
      user: "u",
      apiKey: "k",
      retryDelayMs: 1,
      validate: (x: unknown) => x as { a: number },
    });
    expect(out.a).toBe(2);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("chatJSON throws CerebrasError when repair also fails", async () => {
    const f = vi.fn().mockResolvedValue(ok("not json"));
    vi.stubGlobal("fetch", f);
    await expect(
      chatJSON({
        model: "m",
        system: "s",
        user: "u",
        apiKey: "k",
        validate: (x: unknown) => x as { a: number },
      }),
    ).rejects.toBeInstanceOf(CerebrasError);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
