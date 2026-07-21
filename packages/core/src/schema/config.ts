import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  databaseUrl: string;
  cerebrasApiKey?: string;
  cerebrasBaseUrl: string;
  models: {
    distill: string;
    planner: string;
    rerank: string;
    synthesis: string;
  };
}

function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[m[1]] = value;
    }
  }
}

export function loadConfig(): Config {
  loadDotEnv();
  return {
    databaseUrl:
      process.env.DATABASE_URL ?? "postgres://kb:kb@localhost:5433/kb",
    cerebrasApiKey: process.env.CEREBRAS_API_KEY,
    cerebrasBaseUrl:
      process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1",
    models: {
      distill: process.env.KB_MODEL_DISTILL ?? "gpt-oss-120b",
      planner: process.env.KB_MODEL_PLANNER ?? "gemma-4-31b",
      rerank: process.env.KB_MODEL_RERANK ?? "gemma-4-31b",
      synthesis: process.env.KB_MODEL_SYNTHESIS ?? "zai-glm-4.7",
    },
  };
}
