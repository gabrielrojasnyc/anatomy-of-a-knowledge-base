import { loadConfig } from "../schema/config.js";

export class CerebrasError extends Error {
  constructor(
    msg: string,
    public status?: number,
  ) {
    super(msg);
    this.name = "CerebrasError";
  }
}

export interface ChatOpts {
  model: string;
  system: string;
  user: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  retryDelayMs?: number;
  attempts?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chat(opts: ChatOpts): Promise<string> {
  const cfg = loadConfig();
  const apiKey = opts.apiKey ?? cfg.cerebrasApiKey;
  if (!apiKey) throw new CerebrasError("CEREBRAS_API_KEY is not set");
  const url = `${opts.baseUrl ?? cfg.cerebrasBaseUrl}/chat/completions`;
  const delay = opts.retryDelayMs ?? 1000;
  const attempts = opts.attempts ?? 3;

  let lastErr: CerebrasError | undefined;
  let retryAfterMs: number | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(retryAfterMs ?? delay * 2 ** (attempt - 1));
      retryAfterMs = undefined;
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
          max_completion_tokens: opts.maxTokens ?? 4096,
        }),
      });
      if (!res.ok) {
        const retryAfter = res.headers?.get?.("retry-after");
        const retryAfterSec = retryAfter ? Number(retryAfter) : NaN;
        if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
          retryAfterMs = retryAfterSec * 1000;
        }
        lastErr = new CerebrasError(`Cerebras HTTP ${res.status}`, res.status);
        continue;
      }
      const body = (await res.json()) as {
        choices: { message: { content: string } }[];
      };
      return body.choices[0].message.content;
    } catch (e) {
      lastErr = e instanceof CerebrasError ? e : new CerebrasError(String(e));
    }
  }
  throw lastErr ?? new CerebrasError("unreachable");
}

function stripFences(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

export async function chatJSON<T>(
  opts: ChatOpts & { validate: (x: unknown) => T },
): Promise<T> {
  const first = await chat(opts);
  try {
    return opts.validate(JSON.parse(stripFences(first)));
  } catch {
    const repaired = await chat({
      ...opts,
      user: `${opts.user}\n\nYour previous reply was not valid JSON. Reply with ONLY valid JSON, no prose, no fences.`,
    });
    try {
      return opts.validate(JSON.parse(stripFences(repaired)));
    } catch (e) {
      throw e instanceof CerebrasError ? e : new CerebrasError(String(e));
    }
  }
}
