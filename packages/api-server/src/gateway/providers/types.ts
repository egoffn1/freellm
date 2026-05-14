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
  /** Whether this provider accepts the `tools` / `tool_choice` fields.
   *  Providers that don't support tool calling return 400 when tools are present. */
  readonly supportsTools: boolean;

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
