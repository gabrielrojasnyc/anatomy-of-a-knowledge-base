import type { MetricSample } from "../types/core.js";

const MAX_BUCKETS = 64;

/** Fixed-bucket histogram used for latency and size distributions. */
export class Histogram {
  private buckets: number[];
  private counts: number[];
  private overflow = 0;

  constructor(buckets: number[]) {
    if (buckets.length > MAX_BUCKETS) {
      throw new Error(`histogram supports at most ${MAX_BUCKETS} buckets`);
    }
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.counts = new Array(this.buckets.length).fill(0);
  }

  observe(value: number): void {
    const idx = this.buckets.findIndex((b) => value <= b);
    if (idx === -1) {
      this.overflow += 1;
      return;
    }
    this.counts[idx] += 1;
  }

  snapshot(): { buckets: number[]; counts: number[]; overflow: number } {
    return {
      buckets: [...this.buckets],
      counts: [...this.counts],
      overflow: this.overflow,
    };
  }
}

const samples: MetricSample[] = [];

export function record(
  name: string,
  value: number,
  tags: Record<string, string> = {},
): void {
  samples.push({ name, value, tags, observedAt: new Date().toISOString() });
}

export function drain(): MetricSample[] {
  return samples.splice(0, samples.length);
}

export function count(): number {
  return samples.length;
}
