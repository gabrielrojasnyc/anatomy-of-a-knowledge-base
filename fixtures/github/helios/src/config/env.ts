export interface HeliosConfig {
  prefetchDepth: number;
  manifestFetchTimeoutMs: number;
  replicaCount: number;
  objectStoreEndpoint: string;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * HELIOS_PREFETCH_DEPTH controls how many shards the checkpoint loader
 * fetches concurrently while warming the cache. The default of 16 assumes
 * local SSD, where parallel reads are cheap. Network filesystems like NFS
 * saturate at far lower concurrency; set this to 4 or lower on NFS-backed
 * hosts, or restore stalls silently after the manifest loads (see HEL-482).
 */
export const config: HeliosConfig = {
  prefetchDepth: readInt("HELIOS_PREFETCH_DEPTH", 16),
  manifestFetchTimeoutMs: readInt("HELIOS_MANIFEST_TIMEOUT_MS", 30_000),
  replicaCount: readInt("HELIOS_REPLICA_COUNT", 2),
  objectStoreEndpoint:
    process.env.HELIOS_OBJECT_STORE_ENDPOINT ?? "https://store.internal.helios",
};

export function reloadConfig(): HeliosConfig {
  config.prefetchDepth = readInt("HELIOS_PREFETCH_DEPTH", 16);
  config.manifestFetchTimeoutMs = readInt("HELIOS_MANIFEST_TIMEOUT_MS", 30_000);
  config.replicaCount = readInt("HELIOS_REPLICA_COUNT", 2);
  config.objectStoreEndpoint =
    process.env.HELIOS_OBJECT_STORE_ENDPOINT ?? "https://store.internal.helios";
  return config;
}
