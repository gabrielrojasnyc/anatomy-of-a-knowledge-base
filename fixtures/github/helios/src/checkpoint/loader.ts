import { Manifest, parseManifest, validateShards } from "./manifest.js";
import { ShardCache } from "./shardCache.js";
import { readFileBytes } from "../fs/reader.js";
import { config } from "../config/env.js";

export class CheckpointLoader {
  private manifest?: Manifest;
  constructor(private cache: ShardCache) {}

  async loadManifest(path: string): Promise<Manifest> {
    const bytes = await readFileBytes(path);
    this.manifest = parseManifest(bytes);
    validateShards(this.manifest);
    return this.manifest;
  }

  /**
   * Warm the shard cache ahead of restore. Prefetch depth is read from
   * HELIOS_PREFETCH_DEPTH; the default of 16 assumes local SSD and will
   * saturate an NFS mount. Network storage wants 4 or lower.
   */
  async warmShardCache(): Promise<void> {
    if (!this.manifest) throw new Error("manifest not loaded");
    const depth = config.prefetchDepth;
    const pending: Promise<void>[] = [];
    for (const shard of this.manifest.shards) {
      pending.push(this.cache.pin(shard.key));
      if (pending.length >= depth) {
        await Promise.race(pending);
        pending.splice(0, 1);
      }
    }
    await Promise.all(pending);
  }
}
