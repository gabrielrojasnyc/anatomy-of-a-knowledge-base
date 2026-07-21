import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Manifest, Shard } from "./manifest.js";

/**
 * Writes a checkpoint manifest and its shard bytes to a target directory.
 * Mirrors the checksum scheme validateShards expects in manifest.ts so a
 * manifest produced here always passes restore-side validation.
 */
export async function writeCheckpoint(
  dir: string,
  shards: { key: string; bytes: Buffer }[],
): Promise<Manifest> {
  const shardMeta: Shard[] = [];
  for (const { key, bytes } of shards) {
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await writeFile(`${dir}/${key}`, bytes);
    shardMeta.push({ key, bytes: bytes.byteLength, checksum });
  }
  const manifest: Manifest = {
    version: 1,
    shards: shardMeta,
    checksum: createHash("sha256")
      .update(shardMeta.map((s) => s.checksum).join(""))
      .digest("hex"),
  };
  await writeFile(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));
  return manifest;
}

export function estimateManifestSize(shards: Shard[]): number {
  return shards.reduce((total, s) => total + s.bytes, 0);
}
