import type { ChatCompletionRequest, ModelObject } from "../types.js";
import { BaseProvider } from "./base.js";

const VISION_NAME_PATTERNS = ["llava", "vision", "bakllava", "moondream", "cogvlm", "minicpm-v"];

function isVisionModel(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return VISION_NAME_PATTERNS.some((p) => lower.includes(p));
}

export class OllamaProvider extends BaseProvider {
  readonly id = "ollama";
  readonly name = "Ollama";

  get baseUrl(): string {
    return (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434") + "/v1";
  }

  get models(): ModelObject[] {
    const raw = process.env.OLLAMA_MODELS ?? "";
    if (!raw.trim()) return [];
    return raw
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .map((m) => ({
        id: `ollama/${m}`,
        object: "model" as const,
        created: 1700000000,
        owned_by: "ollama",
        provider: "ollama",
        ...(isVisionModel(m) ? { supportsVision: true } : {}),
      }));
  }

  /**
   * Ollama has no API keys — it uses a baseURL only. When configured, we return a
   * single sentinel "key" so the rest of the base-provider flow (rotation, tracking ID,
   * rate limiter) works uniformly across all providers.
   */
  protected getApiKeys(): string[] {
    return process.env.OLLAMA_BASE_URL ? ["ollama"] : [];
  }

  /** Ollama overrides complete() to skip the Authorization header. */
  async complete(request: ChatCompletionRequest): Promise<Response> {
    const picked = this.pickKey();
    if (!picked) {
      throw new Error(`Provider ${this.name} is not configured`);
    }

    this.stats.totalRequests++;
    this.stats.lastUsedAt = new Date().toISOString();
    this.rateLimiter.recordRequest(picked.trackingId);

    const mapped = this.mapRequest(request);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mapped),
    });

    // Attribute the response to the picked key for onSuccess/onRateLimit hooks.
    // Use the protected helper from BaseProvider.
    this.attachResponseToKey(response, picked.trackingId);
    return response;
  }
}
