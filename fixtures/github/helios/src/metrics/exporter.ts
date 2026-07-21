import { drain } from "./stats.js";
import { log } from "../util/log.js";

export interface ExporterOptions {
  endpoint: string;
  intervalMs: number;
}

/**
 * Periodically drains buffered metric samples and ships them to the
 * collector. Under sustained high request volume the drain can outpace the
 * network flush; samples are dropped rather than buffered unboundedly so
 * the exporter never becomes a memory leak.
 */
export class MetricsExporter {
  private timer?: ReturnType<typeof setInterval>;
  private dropped = 0;

  constructor(private options: ExporterOptions) {}

  start(): void {
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        log.error(`metrics flush failed`, { error: String(err) });
      });
    }, this.options.intervalMs);
  }

  async flush(): Promise<void> {
    const samples = drain();
    if (samples.length === 0) return;
    try {
      await fetch(this.options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(samples),
      });
    } catch (err) {
      this.dropped += samples.length;
      log.warn(`dropped metric samples after failed flush`, {
        dropped: samples.length,
        totalDropped: this.dropped,
      });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
