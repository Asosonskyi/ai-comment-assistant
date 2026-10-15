import { z } from "zod";
import type { Product } from "../config/productSchema";
import type { ThreadContext } from "../core/types";
import { formatPost, UNTRUSTED_NOTE } from "./common";

export const DraftSchema = z.object({
  skip: z.boolean(),
  skipReason: z.string(),
  reply: z.string(),
});

export interface DraftPromptInput {
  product: Product;
  context: ThreadContext;
  maxChars: number;
  recentReplies: string[];
  feedback: string[];
  previousDraft?: string;
}

export function draftPrompt({ product, context, maxChars, recentReplies, feedback, previousDraft }: DraftPromptInput) {
  const linkRule = product.replyPolicy.allowLinks
    ? `You may include ${product.url} only if the author explicitly asks for a link or an app/tool name.`
    : "Do not include any links, URLs or domain names. Mention the product by name only.";

  const system = `You write a single reply to a social media post, posted from the official ${product.name} account.

About ${product.name}: ${product.pitch}

How to write it:
- First respond to what the person actually said: answer the question or acknowledge the need in a useful, specific way.
- Then mention ${product.name} once, naturally, as something that can help. Speak as the brand ("we built ${product.name}...", "${product.name} can..."). Never pretend to be an independent user or customer.
- Language: ${product.language}. Tone: ${product.tone}.
- At most ${maxChars} characters. One or two short sentences is usually best.
- ${linkRule}
- No hashtags, no @mentions, no calls to action like "check it out" or "DM us", at most one emoji.
- Only claim what the description above says the product does.
- Do not reuse the openings or phrasing of the recent replies listed below; every reply must read as written fresh for this person.
- Set skip=true (with skipReason, and reply="") when there is no honest, helpful way to mention ${product.name} here.

${UNTRUSTED_NOTE}`;

  const parts = [
    context.root ? `Conversation starter:\n${formatPost(context.root)}` : "",
    `Post to reply to:\n${formatPost(context.post)}`,
    context.replies.length
      ? `Other replies in the conversation:\n${context.replies.map((reply) => formatPost(reply, "reply")).join("\n")}`
      : "",
    recentReplies.length
      ? `Our recent replies elsewhere (do not repeat their wording):\n${recentReplies.map((text) => `- ${text}`).join("\n")}`
      : "",
    previousDraft ? `Previous draft:\n${previousDraft}` : "",
    feedback.length ? `Reviewer feedback to apply:\n${feedback.map((item) => `- ${item}`).join("\n")}` : "",
  ];

  return { system, user: parts.filter(Boolean).join("\n\n") };
}
