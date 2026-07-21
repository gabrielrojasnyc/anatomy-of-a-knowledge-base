export interface Replica {
  id: string;
  host: string;
  port: number;
  healthy: boolean;
}

export interface ServeRequest {
  requestId: string;
  modelId: string;
  promptTokens: number;
  maxOutputTokens: number;
}

export interface ServeResponse {
  requestId: string;
  outputTokens: number;
  latencyMs: number;
  replicaId: string;
}

export interface RestoreJob {
  id: string;
  manifestPath: string;
  startedAt: string;
  status: "pending" | "running" | "complete" | "failed";
}

export interface AuthPrincipal {
  subject: string;
  scopes: string[];
  expiresAt: string;
}

export interface MetricSample {
  name: string;
  value: number;
  tags: Record<string, string>;
  observedAt: string;
}

export type LogFields = Record<string, unknown>;
