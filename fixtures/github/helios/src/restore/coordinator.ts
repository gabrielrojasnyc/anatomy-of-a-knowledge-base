import { CheckpointLoader } from "../checkpoint/loader.js";
import { ShardCache } from "../checkpoint/shardCache.js";
import { fetchManifest } from "./fetcher.js";
import { verifyRestore } from "./verifier.js";
import { log } from "../util/log.js";
import type { RestoreJob } from "../types/core.js";

/**
 * Orchestrates a full restore: fetch the manifest from object storage,
 * load and validate it, warm the shard cache, then verify the result.
 * This is the entry point the CLI and the serving startup path both call.
 */
export class RestoreCoordinator {
  private jobs = new Map<string, RestoreJob>();

  async startRestore(manifestPath: string): Promise<RestoreJob> {
    const job: RestoreJob = {
      id: crypto.randomUUID(),
      manifestPath,
      startedAt: new Date().toISOString(),
      status: "pending",
    };
    this.jobs.set(job.id, job);
    this.runRestore(job).catch((err) => {
      job.status = "failed";
      log.error(`restore failed`, { jobId: job.id, error: String(err) });
    });
    return job;
  }

  private async runRestore(job: RestoreJob): Promise<void> {
    job.status = "running";
    const fetched = await fetchManifest(job.manifestPath);
    const cache = new ShardCache();
    const loader = new CheckpointLoader(cache);
    await loader.loadManifest(job.manifestPath);
    await loader.warmShardCache();
    const ok = await verifyRestore(job.id, fetched.bytes.byteLength);
    job.status = ok ? "complete" : "failed";
    log.info(`restore finished`, { jobId: job.id, status: job.status });
  }

  getJob(id: string): RestoreJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): RestoreJob[] {
    return [...this.jobs.values()];
  }
}
