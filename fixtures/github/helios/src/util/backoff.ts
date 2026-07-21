export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
  jitter: boolean;
}

const DEFAULT_OPTIONS: BackoffOptions = {
  baseMs: 200,
  maxMs: 10_000,
  maxAttempts: 6,
  jitter: true,
};

/** Exponential backoff with optional full jitter, capped at maxMs. */
export function computeDelayMs(
  attempt: number,
  options: Partial<BackoffOptions> = {},
): number {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
  if (!opts.jitter) return exp;
  return Math.floor(Math.random() * exp);
}

/**
 * Retries an async operation with exponential backoff. Used by the restore
 * coordinator and fetcher when object storage returns transient errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<BackoffOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < opts.maxAttempts - 1) {
        const delay = computeDelayMs(attempt, opts);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
