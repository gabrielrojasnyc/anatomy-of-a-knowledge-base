import type { HeliosConfig } from "../config/env.js";
import { log } from "../util/log.js";

export interface ValidationError {
  field: string;
  reason: string;
}

/**
 * Validates the serving configuration before the process accepts traffic.
 * Any invalid field aborts startup immediately rather than letting the
 * server come up in a half-configured state; a bad replica count or a
 * malformed endpoint fails loudly here instead of surfacing as a mystery
 * error under load later.
 */
export function validateServingConfig(cfg: HeliosConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!Number.isInteger(cfg.replicaCount) || cfg.replicaCount < 1) {
    errors.push({
      field: "replicaCount",
      reason: "must be a positive integer",
    });
  }
  if (cfg.prefetchDepth < 1 || cfg.prefetchDepth > 256) {
    errors.push({
      field: "prefetchDepth",
      reason: "must be between 1 and 256",
    });
  }
  if (cfg.manifestFetchTimeoutMs < 1000) {
    errors.push({
      field: "manifestFetchTimeoutMs",
      reason: "must be at least 1000ms to avoid spurious timeouts",
    });
  }
  try {
    new URL(cfg.objectStoreEndpoint);
  } catch {
    errors.push({
      field: "objectStoreEndpoint",
      reason: "must be a valid URL",
    });
  }

  return errors;
}

/** Called once at process start. Throws to abort startup on any error. */
export function assertValidOrExit(cfg: HeliosConfig): void {
  const errors = validateServingConfig(cfg);
  if (errors.length === 0) return;
  for (const e of errors) {
    log.error(`invalid config`, { field: e.field, reason: e.reason });
  }
  throw new Error(
    `serving startup aborted: ${errors.length} invalid configuration field(s)`,
  );
}
