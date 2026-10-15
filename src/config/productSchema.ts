import { z } from "zod";

export const LlmStages = ["queryPlanner", "rank", "draft", "moderate"] as const;
export type LlmStage = (typeof LlmStages)[number];

const LlmChoiceSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high"]).optional(),
});
export type LlmChoice = z.infer<typeof LlmChoiceSchema>;

export const ProductSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes only"),
  name: z.string().min(1),
  url: z.url(),
  // What the product does and who it is for. The drafter uses this to mention it naturally.
  pitch: z.string().min(20),
  language: z.string().default("en"),
  tone: z.string().default("friendly, helpful, short, no hard sell"),

  platform: z.object({
    name: z.string().min(1),
    // Optional env var holding a fallback long-lived token (used until OAuth login replaces it).
    tokenEnv: z.string().optional(),
  }),

  discovery: z.object({
    // Plain-language description of the conversations to find; fed to the query planner and ranker.
    topicDescription: z.string().min(10),
    keywords: z.array(z.string().min(1)).default([]),
    tags: z.array(z.string().min(1)).default([]),
    useQueryPlanner: z.boolean().default(true),
    maxQueries: z.number().int().min(1).max(20).default(6),
    searchType: z.enum(["RECENT", "TOP"]).default("RECENT"),
    sinceHours: z.number().int().min(1).max(24 * 7).default(24),
    mediaType: z.enum(["TEXT", "IMAGE", "VIDEO"]).nullable().default(null),
    perQueryLimit: z.number().int().min(1).max(100).default(25),
    // Dev-mode only: Threads keyword search returns only your own posts until App Review passes.
    includeOwnPosts: z.boolean().default(false),
  }),

  filters: z
    .object({
      excludeKeywords: z.array(z.string()).default([]),
      excludeAuthors: z.array(z.string()).default([]),
      minRelevance: z.number().min(0).max(1).default(0.7),
      maxDraftsPerRun: z.number().int().min(1).max(50).default(5),
    })
    .prefault({}),

  replyPolicy: z
    .object({
      allowLinks: z.boolean().default(false),
      maxChars: z.number().int().min(50).max(500).default(400),
      dailyCap: z.number().int().min(1).default(20),
      minGapMinutes: z.number().min(0).default(10),
      jitterMinutes: z.number().min(0).default(10),
      bannedPhrases: z.array(z.string()).default([]),
      // Trigram similarity at or above this against a recent reply blocks the draft.
      maxSimilarity: z.number().min(0).max(1).default(0.6),
    })
    .prefault({}),

  llm: z
    .object({
      default: LlmChoiceSchema,
      queryPlanner: LlmChoiceSchema.optional(),
      rank: LlmChoiceSchema.optional(),
      draft: LlmChoiceSchema.optional(),
      moderate: LlmChoiceSchema.optional(),
    }),

  approval: z.object({
    channel: z.string().default("telegram"),
    // Numeric chat id (send /chatid to the bot to get it) or "@channelusername".
    // 0 = not set yet: the server boots so you can ask the bot, but runs are refused.
    chatId: z.union([z.number().int(), z.string().regex(/^@\w+$/, "use a numeric chat id or @channelusername")]),
  }),
});

export type Product = z.infer<typeof ProductSchema>;

export function llmChoiceFor(product: Product, stage: LlmStage): LlmChoice {
  return product.llm[stage] ?? product.llm.default;
}
