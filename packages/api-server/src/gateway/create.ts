import { ProviderRegistry } from "./registry.js";
import { GatewayRouter } from "./router.js";
import { ObservabilityStore } from "./observability.js";

export interface Gateway {
  registry: ProviderRegistry;
  router: GatewayRouter;
  obs: ObservabilityStore;
}

export function createGateway(): Gateway {
  const registry = new ProviderRegistry();
  const obs = new ObservabilityStore();
  const router = new GatewayRouter(registry, obs);
  return { registry, router, obs };
}
