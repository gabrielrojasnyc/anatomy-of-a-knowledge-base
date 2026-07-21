import { config } from "../config/env.js";
import { assertValidOrExit } from "./configValidate.js";
import { Router } from "./router.js";
import { handleRequest } from "../api/http.js";
import { log } from "../util/log.js";
import type { Replica } from "../types/core.js";

/**
 * Top-level serving process. Validates configuration before doing anything
 * else, then brings up the router and starts accepting connections. If
 * configValidate finds a problem, the process exits without ever binding
 * a port.
 */
export class Server {
  private router = new Router();
  private listening = false;

  async start(port: number, replicas: Replica[]): Promise<void> {
    assertValidOrExit(config);
    this.router.setReplicas(replicas);
    this.listening = true;
    log.info(`server started`, { port, replicaCount: replicas.length });
  }

  async handle(rawBody: string): Promise<string> {
    if (!this.listening) {
      throw new Error("server not started");
    }
    return handleRequest(rawBody, this.router);
  }

  setCanary(replicaIds: string[], weight: number): void {
    this.router.setCanary(replicaIds, weight);
    log.info(`canary weight updated`, { replicaIds, weight });
  }

  async stop(): Promise<void> {
    this.listening = false;
    log.info(`server stopped`);
  }
}
