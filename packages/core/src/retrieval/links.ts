import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * Distillation asks the model for code_refs: file paths, flags, and function
 * names a thread mentions. Refs that name a real file become links an agent
 * can hand straight to get_document; flags and function names stay out,
 * search_code is the tool for those. Existence is checked here so a link is
 * a promise, never a guess.
 */
export function codeLinks(
  metadata: Record<string, unknown>,
  fixturesDir?: string,
): string[] {
  if (!fixturesDir) return [];
  const refs = (metadata.code_refs as string[]) ?? [];
  return refs
    .filter((r) => {
      if (r.includes("..")) return false;
      try {
        return statSync(join(fixturesDir, "github/helios", r)).isFile();
      } catch {
        return false;
      }
    })
    .map((r) => `github://helios/${r}`);
}
