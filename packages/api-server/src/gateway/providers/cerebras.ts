import { BaseProvider, parseApiKeys } from "./base.js";
import type { ModelObject } from "../types.js";

export class CerebrasProvider extends BaseProvider {
  readonly id = "cerebras";
  readonly name = "Cerebras";
  override readonly supportsStreamUsage = true;

  get baseUrl(): string {
    return process.env["CEREBRAS_BASE_URL"] ?? "https://api.cerebras.ai/v1";
  }

  readonly models: ModelObject[] = [
    { id: "cerebras/llama3.1-8b", object: "model", created: 1700000000, owned_by: "meta", provider: "cerebras" },
    { id: "cerebras/qwen-3-235b-a22b-instruct-2507", object: "model", created: 1700000000, owned_by: "alibaba", provider: "cerebras" },
    { id: "cerebras/gpt-oss-120b", object: "model", created: 1700000000, owned_by: "openai", provider: "cerebras" },
  ];

  protected getApiKeys(): string[] {
    return parseApiKeys(process.env["CEREBRAS_API_KEY"]);
  }
}
