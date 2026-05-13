import type {
  ChatCompletionRequest,
  KeyStatus,
  ModelObject,
  ProviderStats,
  CircuitBreakerState,
} from "../types.js";

export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly models: ModelObject[];
  readonly supportsStreamUsage: boolean;

  isEnabled(): boolean;
  getStats(): ProviderStats;
  getCircuitBreakerState(): CircuitBreakerState;
  isAvailable(): boolean;
  getKeysStatus(): KeyStatus[];

  complete(request: ChatCompletionRequest): Promise<Response>;
  onSuccess(response: Response): void;
  onRateLimit(response: Response, retryAfterSeconds?: number): void;
  onError(): void;
  resetCircuitBreaker(): void;
}
