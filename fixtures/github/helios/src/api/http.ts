import type { Router } from "../serving/router.js";
import type { ServeRequest, ServeResponse } from "../types/core.js";
import { verifyToken, requireScope } from "./auth.js";
import { log } from "../util/log.js";

interface RawEnvelope {
  token: string;
  requestId: string;
  modelId: string;
  promptTokens: number;
  maxOutputTokens: number;
}

/** Parses, authenticates, and routes a single serving request. */
export async function handleRequest(
  rawBody: string,
  router: Router,
): Promise<string> {
  const envelope = JSON.parse(rawBody) as RawEnvelope;
  const principal = verifyToken(envelope.token);
  requireScope(principal, "serve:invoke");

  const req: ServeRequest = {
    requestId: envelope.requestId,
    modelId: envelope.modelId,
    promptTokens: envelope.promptTokens,
    maxOutputTokens: envelope.maxOutputTokens,
  };

  const start = Date.now();
  const replica = router.pick(req);
  const response: ServeResponse = {
    requestId: req.requestId,
    outputTokens: Math.min(req.maxOutputTokens, req.promptTokens * 2),
    latencyMs: Date.now() - start,
    replicaId: replica.id,
  };

  log.info(`request served`, {
    requestId: req.requestId,
    replicaId: replica.id,
  });
  return JSON.stringify(response);
}

export function badRequest(message: string): string {
  return JSON.stringify({ error: message }, null, 2);
}
