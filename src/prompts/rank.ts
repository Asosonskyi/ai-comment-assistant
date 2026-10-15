import { z } from "zod";
import type { Product } from "../config/productSchema";
import type { NeutralPost } from "../core/types";
import { formatPost, UNTRUSTED_NOTE } from "./common";

export const RankSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      relevance: z.number(),
      isAskingForHelp: z.boolean(),
      sensitive: z.boolean(),
      reason: z.string(),
    }),
  ),
});

export function rankPrompt(product: Product, posts: NeutralPost[]) {
  const system = `You decide which social media posts are a good place for a brand account to leave a genuinely helpful reply.

For every post return:
- relevance: 0.0-1.0. High only when the author has a real need that ${product.name} directly addresses and a reply mentioning it would likely be welcome. Low for promotions, jokes, news, rants with no need, or posts where a brand reply would feel intrusive.
- isAskingForHelp: true when the author asks a question or asks for recommendations.
- sensitive: true for grief, health or mental-health crises, self-harm, politics, religion, minors, legal disputes, or anything where a brand reply would be inappropriate.
- reason: one short sentence.

Return one result per post, using the post id exactly as given.
${UNTRUSTED_NOTE}`;

  const user = `Product: ${product.name}
What it does: ${product.pitch}
Target conversations: ${product.discovery.topicDescription}

Posts:
${posts.map((post) => formatPost(post)).join("\n\n")}`;

  return { system, user };
}
