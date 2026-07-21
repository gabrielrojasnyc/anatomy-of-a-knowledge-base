import { readFile, stat } from "node:fs/promises";

/**
 * Thin wrapper around node fs used by the checkpoint loader and shard cache.
 * Centralizing reads here means retry and timeout behavior can be added in
 * one place without touching call sites.
 */
export async function readFileBytes(path: string): Promise<Buffer> {
  return readFile(path);
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function fileSizeBytes(path: string): Promise<number> {
  const info = await stat(path);
  return info.size;
}

/**
 * Reads a byte range from a file. Used when a shard is too large to pull
 * into memory in one call, or when resuming a partial fetch.
 */
export async function readFileRange(
  path: string,
  start: number,
  end: number,
): Promise<Buffer> {
  const full = await readFile(path);
  return full.subarray(start, end);
}
