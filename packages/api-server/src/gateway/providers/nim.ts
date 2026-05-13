import { BaseProvider, parseApiKeys } from "./base.js";
import type { ChatCompletionRequest, ModelObject } from "../types.js";

/**
 * NVIDIA NIM OpenAI-compatibility adapter.
 *
 * NIM's OpenAI-compat endpoint does not support the standard
 * `response_format: { type: "json_schema" }` field. Sending it is
 * silently ignored, so structured-output requests produce unstructured
 * text. NIM instead expects the JSON Schema to arrive as
 * `nvext.guided_json` in the request body.
 *
 * This adapter translates:
 *   response_format.type === "json_schema"
 *     -> nvext: { guided_json: <schema> }  (response_format removed)
 *
 * `response_format.type === "json_object"` is left as-is because NIM
 * accepts it natively (though enforcement is weak).
 *
 * Everything else flows through the base mapRequest untouched.
 */
export class NimProvider extends BaseProvider {
  readonly id = "nim";
  readonly name = "NVIDIA NIM";
  override readonly supportsStreamUsage = true;

  get baseUrl(): string {
    return process.env["NIM_BASE_URL"] ?? "https://integrate.api.nvidia.com/v1";
  }

  readonly models: ModelObject[] = [
    { id: "nim/meta/llama-3.3-70b-instruct", object: "model", created: 1700000000, owned_by: "meta", provider: "nim" },
    { id: "nim/meta/llama-3.1-405b-instruct", object: "model", created: 1700000000, owned_by: "meta", provider: "nim" },
    { id: "nim/meta/llama-3.1-70b-instruct", object: "model", created: 1700000000, owned_by: "meta", provider: "nim" },
    { id: "nim/meta/llama-3.1-8b-instruct", object: "model", created: 1700000000, owned_by: "meta", provider: "nim" },
    { id: "nim/nvidia/llama-3.1-nemotron-70b-instruct", object: "model", created: 1700000000, owned_by: "nvidia", provider: "nim" },
    { id: "nim/mistralai/mixtral-8x22b-instruct-v0.1", object: "model", created: 1700000000, owned_by: "mistral", provider: "nim" },
    { id: "nim/deepseek-ai/deepseek-r1", object: "model", created: 1700000000, owned_by: "deepseek", provider: "nim" },
  ];

  protected getApiKeys(): string[] {
    return parseApiKeys(process.env["NVIDIA_NIM_API_KEY"]);
  }

  /**
   * Translate `response_format: { type: "json_schema" }` into NIM's
   * proprietary `nvext.guided_json` field. NIM silently ignores the
   * standard json_schema format, so without this translation callers
   * get unstructured text instead of valid JSON.
   */
  protected override mapRequest(
    request: ChatCompletionRequest,
  ): ChatCompletionRequest {
    const mapped = super.mapRequest(request);

    if (
      mapped.response_format?.type === "json_schema" &&
      mapped.response_format.json_schema?.schema
    ) {
      const schema = mapped.response_format.json_schema.schema;
      (mapped as unknown as Record<string, unknown>).nvext = { guided_json: schema };
      delete mapped.response_format;
    }

    return mapped;
  }
}
