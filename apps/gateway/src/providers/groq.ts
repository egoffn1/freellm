import type { ModelObject } from "../types.js";
import { BaseProvider, parseApiKeys } from "./base.js";

export class GroqProvider extends BaseProvider {
  readonly id = "groq";
  readonly name = "Groq";
  override readonly supportsStreamUsage = true;

  get baseUrl(): string {
    return process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";
  }

  readonly models: ModelObject[] = [
    {
      id: "groq/llama-3.3-70b-versatile",
      object: "model",
      created: 1700000000,
      owned_by: "meta",
      provider: "groq",
    },
    {
      id: "groq/llama-3.1-8b-instant",
      object: "model",
      created: 1700000000,
      owned_by: "meta",
      provider: "groq",
    },
    {
      id: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
      object: "model",
      created: 1700000000,
      owned_by: "meta",
      provider: "groq",
      supportsVision: true,
    },
    {
      id: "groq/qwen/qwen3-32b",
      object: "model",
      created: 1700000000,
      owned_by: "alibaba",
      provider: "groq",
    },
  ];

  protected getApiKeys(): string[] {
    return parseApiKeys(process.env.GROQ_API_KEY);
  }
}
