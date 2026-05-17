import { ProviderRegistry } from "./registry.js";
import { GatewayRouter } from "./router.js";
import { ObservabilityStore } from "../observability/index.js";

export { AllProvidersExhaustedError, ProviderClientError } from "./router.js";
export { ObservabilityStore } from "../observability/index.js";
export type * from "../types.js";

const registry = new ProviderRegistry();
const obs = new ObservabilityStore();
const router = new GatewayRouter(registry, obs);

export { registry, router, obs };
