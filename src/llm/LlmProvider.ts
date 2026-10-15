import type { z } from "zod";

export interface LlmRequest {
  model: string;
  system: string;
  user: string;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
}

// Every pipeline LLM call returns JSON validated against a zod schema, so
// providers are interchangeable per stage.
export interface LlmProvider {
  readonly name: string;
  generateJson<S extends z.ZodType>(schema: S, schemaName: string, request: LlmRequest): Promise<z.infer<S>>;
}

export class LlmRefusalError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider} declined the request: ${detail}`);
    this.name = "LlmRefusalError";
  }
}
