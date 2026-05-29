import type { ModelObject } from "../types.js";
import { BaseProvider, parseApiKeys } from "./base.js";

/**
 * GitHub Models provider.
 *
 * GitHub Models exposes an OpenAI-compatible inference endpoint hosted at
 * https://models.github.ai/inference. The legacy Azure hostname
 * (models.inference.ai.azure.com) is deprecated and is NOT used here.
 *
 * Environment variable: GITHUB_MODELS_API_KEY
 *
 * We deliberately do NOT read GITHUB_TOKEN or GITHUB_API_KEY. Those names
 * collide with standard dotfile and CI environment conventions (gh CLI,
 * Actions, dependabot, etc.), which would cause the gateway to accidentally
 * pick up unrelated tokens and send them upstream. GITHUB_MODELS_API_KEY is
 * a dedicated, scoped variable that only this provider reads.
 *
 * Authentication tokens can be either:
 *   - A classic PAT with either no scopes or the `repo` scope (public models
 *     access works with either).
 *   - A fine-grained PAT with the `Models: read` account permission.
 *
 * Free-tier rate limits (for maintainer reference):
 *   - Low-tier models: 15 requests/minute, 150 requests/day.
 *   - High-tier models: 10 requests/minute, 50 requests/day.
 *
 * The shared rate-limiter tracks only the per-minute cap. Daily quotas are
 * enforced by GitHub returning HTTP 429 with a Retry-After header, which our
 * normal onRateLimit cooldown path in BaseProvider handles transparently.
 *
 * Model id format: `github/<vendor>/<model>` (e.g. `github/openai/gpt-4o-mini`).
 * The base class mapRequest strips only the `github/` provider prefix, leaving
 * `<vendor>/<model>` as the upstream model id, which is exactly what the
 * GitHub Models inference endpoint expects.
 */
export class GitHubModelsProvider extends BaseProvider {
  readonly id = "github";
  readonly name = "GitHub Models";
  override readonly supportsStreamUsage = true;

  get baseUrl(): string {
    return process.env.GITHUB_MODELS_BASE_URL ?? "https://models.github.ai/inference";
  }

  readonly models: ModelObject[] = [
    {
      id: "github/openai/gpt-4o-mini",
      object: "model",
      created: 1700000000,
      owned_by: "openai",
      provider: "github",
      supportsVision: true,
    },
    {
      id: "github/openai/gpt-4.1-mini",
      object: "model",
      created: 1700000000,
      owned_by: "openai",
      provider: "github",
      supportsVision: true,
    },
    {
      id: "github/meta/Meta-Llama-3.3-70B-Instruct",
      object: "model",
      created: 1700000000,
      owned_by: "meta",
      provider: "github",
    },
    {
      id: "github/meta/Llama-3.2-11B-Vision-Instruct",
      object: "model",
      created: 1700000000,
      owned_by: "meta",
      provider: "github",
      supportsVision: true,
    },
    {
      id: "github/microsoft/Phi-4",
      object: "model",
      created: 1700000000,
      owned_by: "microsoft",
      provider: "github",
    },
    {
      id: "github/cohere/Command-R-plus-08-2024",
      object: "model",
      created: 1700000000,
      owned_by: "cohere",
      provider: "github",
    },
    {
      id: "github/mistral-ai/Mistral-Large-2411",
      object: "model",
      created: 1700000000,
      owned_by: "mistral",
      provider: "github",
    },
  ];

  protected getApiKeys(): string[] {
    return parseApiKeys(process.env.GITHUB_MODELS_API_KEY);
  }
}
