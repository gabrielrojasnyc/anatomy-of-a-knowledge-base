import type { Replica, ServeRequest } from "../types/core.js";
import { log } from "../util/log.js";

/**
 * Picks a healthy replica for an incoming request. Supports a canary weight
 * so a fraction of traffic can be steered to a newly deployed replica set
 * before it takes the full load; see HEL-021 for the rollout process this
 * backs.
 */
export class Router {
  private replicas: Replica[] = [];
  private canaryWeight = 0;
  private canaryReplicaIds = new Set<string>();

  setReplicas(replicas: Replica[]): void {
    this.replicas = replicas;
  }

  setCanary(replicaIds: string[], weight: number): void {
    this.canaryReplicaIds = new Set(replicaIds);
    this.canaryWeight = Math.min(1, Math.max(0, weight));
  }

  pick(_req: ServeRequest): Replica {
    const healthy = this.replicas.filter((r) => r.healthy);
    if (healthy.length === 0) {
      throw new Error("no healthy replicas available");
    }
    const canaryPool = healthy.filter((r) => this.canaryReplicaIds.has(r.id));
    const stablePool = healthy.filter((r) => !this.canaryReplicaIds.has(r.id));

    if (canaryPool.length > 0 && Math.random() < this.canaryWeight) {
      return pickRandom(canaryPool);
    }
    if (stablePool.length > 0) {
      return pickRandom(stablePool);
    }
    return pickRandom(canaryPool);
  }

  markUnhealthy(replicaId: string): void {
    const replica = this.replicas.find((r) => r.id === replicaId);
    if (replica) {
      replica.healthy = false;
      log.warn(`replica marked unhealthy`, { replicaId });
    }
  }
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}
