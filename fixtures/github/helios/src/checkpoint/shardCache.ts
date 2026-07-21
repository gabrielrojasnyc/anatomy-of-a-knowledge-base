import { readFileBytes } from "../fs/reader.js";
import { log } from "../util/log.js";

interface CacheEntry {
  bytes: Buffer;
  pinned: boolean;
  lastUsed: number;
}

/**
 * In-memory cache for shard bytes fetched during restore. Pinning keeps a
 * shard resident until the loader explicitly releases it; unpinned entries
 * are evicted LRU-first once the cache exceeds maxBytes.
 */
export class ShardCache {
  private entries = new Map<string, CacheEntry>();
  private currentBytes = 0;

  constructor(private maxBytes: number = 8 * 1024 * 1024 * 1024) {}

  async pin(key: string): Promise<void> {
    const existing = this.entries.get(key);
    if (existing) {
      existing.pinned = true;
      existing.lastUsed = Date.now();
      return;
    }
    const bytes = await readFileBytes(key);
    this.evictIfNeeded(bytes.byteLength);
    this.entries.set(key, { bytes, pinned: true, lastUsed: Date.now() });
    this.currentBytes += bytes.byteLength;
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.pinned = false;
  }

  get(key: string): Buffer | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastUsed = Date.now();
    return entry.bytes;
  }

  private evictIfNeeded(incomingBytes: number): void {
    if (this.currentBytes + incomingBytes <= this.maxBytes) return;
    const candidates = [...this.entries.entries()]
      .filter(([, e]) => !e.pinned)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of candidates) {
      this.entries.delete(key);
      this.currentBytes -= entry.bytes.byteLength;
      log.debug(`shard cache evicted ${key}`);
      if (this.currentBytes + incomingBytes <= this.maxBytes) return;
    }
  }

  size(): number {
    return this.currentBytes;
  }
}
