import { z } from "zod";
import type { Product } from "../config/productSchema";

export const QueryPlanSchema = z.object({
  queries: z.array(
    z.object({
      q: z.string(),
      mode: z.enum(["KEYWORD", "TAG"]),
    }),
  ),
});

export function queryPlannerPrompt(product: Product, count: number) {
  const system = `You plan social media searches that find public posts where people would genuinely benefit from hearing about a product.

Rules:
- Return ${count} search queries.
- KEYWORD queries are 1-4 words people would actually type in a post (a need, a question, a frustration), not marketing language.
- TAG queries are a single topic tag without the # sign.
- Write queries in the product's language: ${product.language}.
- Prefer queries that surface people asking for help or recommendations, not people promoting things.
- Do not include the product's own name.`;

  const user = `Product: ${product.name}
What it does: ${product.pitch}

Conversations to find: ${product.discovery.topicDescription}
Seed keywords: ${product.discovery.keywords.join(", ") || "(none)"}
Seed tags: ${product.discovery.tags.join(", ") || "(none)"}
Exclude topics containing: ${product.filters.excludeKeywords.join(", ") || "(none)"}`;

  return { system, user };
}
