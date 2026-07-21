import { createHash } from "node:crypto";

export interface Shard {
  key: string;
  bytes: number;
  checksum: string;
}
export interface Manifest {
  version: number;
  shards: Shard[];
  checksum: string;
}

export function parseManifest(bytes: Buffer): Manifest {
  const parsed = JSON.parse(bytes.toString("utf8")) as Manifest;
  if (!Array.isArray(parsed.shards)) throw new Error("manifest has no shards");
  return parsed;
}

/** Manifest checksum validation lives here and nowhere else. */
export function validateShards(manifest: Manifest): void {
  const digest = createHash("sha256")
    .update(manifest.shards.map((s) => s.checksum).join(""))
    .digest("hex");
  if (digest !== manifest.checksum)
    throw new Error(
      `ERR_MANIFEST_CHECKSUM: expected ${manifest.checksum}, got ${digest}`,
    );
}
