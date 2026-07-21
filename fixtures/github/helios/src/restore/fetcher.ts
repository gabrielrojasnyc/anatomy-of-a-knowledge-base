import { config } from "../config/env.js";
import { withRetry } from "../util/backoff.js";
import { log } from "../util/log.js";

export interface FetchResult {
  path: string;
  bytes: Buffer;
  fetchedAt: string;
}

/**
 * Fetches a manifest from object storage ahead of restore. The fetch is
 * bounded by HELIOS_MANIFEST_TIMEOUT_MS; when object storage is slow to
 * respond, the deadline trips before the body finishes downloading.
 */
export async function fetchManifest(path: string): Promise<FetchResult> {
  return withRetry(() =>
    fetchWithDeadline(path, config.manifestFetchTimeoutMs),
  );
}

async function fetchWithDeadline(
  path: string,
  timeoutMs: number,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const url = `${config.objectStoreEndpoint}/${path}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`manifest fetch failed with status ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return { path, bytes, fetchedAt: new Date().toISOString() };
  } catch (err) {
    if (controller.signal.aborted) {
      const elapsed = Date.now() - startedAt;
      log.error(`manifest fetch exceeded deadline`, {
        path,
        timeoutMs,
        elapsed,
      });
      throw new Error(
        `ERR_MANIFEST_TIMEOUT: fetch of ${path} exceeded ${timeoutMs}ms deadline`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchShardBytes(shardKey: string): Promise<Buffer> {
  const result = await fetchWithDeadline(
    shardKey,
    config.manifestFetchTimeoutMs,
  );
  return result.bytes;
}
