import { z } from "zod";
import type { Product } from "../config/productSchema";
import type { NeutralPost } from "../core/types";
import { formatPost, UNTRUSTED_NOTE } from "./common";

export const ModerationSchema = z.object({
  safe: z.boolean(),
  issues: z.array(z.string()),
});

export function moderatePrompt(product: Product, post: NeutralPost, reply: string) {
  const system = `You review a reply that the official ${product.name} account is about to post on social media. Flag it (safe=false) if any of these apply:
- rude, toxic, sarcastic, or dismissive toward the author
- claims about ${product.name} that are not supported by this description: ${product.pitch}
- pretends to be an independent user or customer rather than the brand
- pushy or spammy (pressure, hype, calls to action, multiple mentions of the product)
- inappropriate for the post's context (grief, crisis, sensitive topics)
- off-topic: does not respond to what the author said
- medical, legal or financial advice
List each problem in issues (empty when safe).
${UNTRUSTED_NOTE}`;

  const user = `${formatPost(post)}\n\n<reply>\n${reply}\n</reply>`;
  return { system, user };
}
