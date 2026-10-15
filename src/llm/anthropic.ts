import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { LlmRefusalError, type LlmProvider, type LlmRequest } from "./LlmProvider";

// Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private client?: Anthropic;

  async generateJson<S extends z.ZodType>(schema: S, _schemaName: string, request: LlmRequest): Promise<z.infer<S>> {
    // Resolves credentials from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile.
    this.client ??= new Anthropic();
    const useFallbacks = FALLBACK_MODELS.has(request.model);

    const response = await this.client.beta.messages.parse({
      model: request.model,
      max_tokens: request.maxTokens ?? 16000,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      output_config: {
        ...(request.effort ? { effort: request.effort } : {}),
        format: betaZodOutputFormat(schema),
      },
      ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });

    if (response.stop_reason === "refusal") {
      throw new LlmRefusalError(this.name, response.stop_details?.category ?? "no category");
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error(`anthropic: output hit max_tokens (${request.maxTokens ?? 16000})`);
    }
    if (response.parsed_output == null) {
      throw new Error("anthropic: response did not match the expected JSON schema");
    }
    return response.parsed_output as z.infer<S>;
  }
}
