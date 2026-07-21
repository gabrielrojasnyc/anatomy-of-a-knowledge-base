import { loadConfig } from "../schema/config.js";

export class CerebrasError extends Error {
  constructor(
    msg: string,
    public status?: number,
  ) {
    super(msg);
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
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chat(opts: ChatOpts): Promise<string> {
  const cfg = loadConfig();
  const apiKey = opts.apiKey ?? cfg.cerebrasApiKey;
  if (!apiKey) throw new CerebrasError("CEREBRAS_API_KEY is not set");
  const url = `${opts.baseUrl ?? cfg.cerebrasBaseUrl}/chat/completions`;
  const delay = opts.retryDelayMs ?? 1000;

  let lastErr: CerebrasError | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(delay * 2 ** (attempt - 1));
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
    return opts.validate(JSON.parse(stripFences(repaired)));
  }
}
