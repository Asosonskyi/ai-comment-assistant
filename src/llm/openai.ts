import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { LlmRefusalError, type LlmProvider, type LlmRequest } from "./LlmProvider";

export class OpenAiProvider implements LlmProvider {
  readonly name = "openai";
  private client?: OpenAI;

  async generateJson<S extends z.ZodType>(schema: S, schemaName: string, request: LlmRequest): Promise<z.infer<S>> {
    // Reads OPENAI_API_KEY from the environment.
    this.client ??= new OpenAI();

    const response = await this.client.responses.parse({
      model: request.model,
      max_output_tokens: request.maxTokens ?? 16000,
      input: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      text: { format: zodTextFormat(schema, schemaName) },
    });

    for (const output of response.output) {
      if (output.type !== "message") continue;
      for (const item of output.content) {
        if (item.type === "refusal") throw new LlmRefusalError(this.name, item.refusal);
      }
    }
    if (response.output_parsed == null) {
      throw new Error("openai: response did not match the expected JSON schema");
    }
    return response.output_parsed as z.infer<S>;
  }
}
