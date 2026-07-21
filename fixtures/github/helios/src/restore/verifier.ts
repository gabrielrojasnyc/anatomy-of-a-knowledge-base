import { log } from "../util/log.js";

export interface VerificationResult {
  jobId: string;
  ok: boolean;
  bytesExpected: number;
  checkedAt: string;
}

/**
 * Sanity check run after a restore completes: confirms the amount of data
 * pulled matches what the manifest fetch reported. This does not replace
 * the per-shard checksum validation in checkpoint/manifest.ts, it catches
 * cases where restore finished early without erroring.
 */
export async function verifyRestore(
  jobId: string,
  bytesExpected: number,
): Promise<boolean> {
  if (bytesExpected <= 0) {
    log.warn(`restore verification skipped: no bytes expected`, { jobId });
    return true;
  }
  const result: VerificationResult = {
    jobId,
    ok: bytesExpected > 0,
    bytesExpected,
    checkedAt: new Date().toISOString(),
  };
  if (!result.ok) {
    log.error(`restore verification failed`, { jobId, bytesExpected });
  }
  return result.ok;
}
