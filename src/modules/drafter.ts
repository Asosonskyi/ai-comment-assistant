import type { Product } from "../config/productSchema";
import type { AppContext } from "../core/context";
import type { Candidate } from "../core/types";
import { DraftSchema, draftPrompt } from "../prompts/draft";

const RECENT_REPLIES_IN_PROMPT = 10;

export type DraftResult = { skip: true; reason: string } | { skip: false; text: string };

// Module 5: write one reply using the conversation context and the product's voice.
export async function writeDraft(
  product: Product,
  candidate: Candidate,
  ctx: AppContext,
  revision: { feedback: string[]; previousDraft?: string } = { feedback: [] },
): Promise<DraftResult> {
  const adapter = ctx.registry.adapter(product);
  const context = await adapter.getThreadContext(candidate.post);
  const recentReplies = (await ctx.store.listReplies(product.id))
    .slice(-RECENT_REPLIES_IN_PROMPT)
    .map((reply) => reply.text);

  const { provider, choice } = ctx.registry.llm(product, "draft");
  const result = await provider.generateJson(DraftSchema, "reply_draft", {
    model: choice.model,
    effort: choice.effort,
    ...draftPrompt({
      product,
      context,
      maxChars: maxReplyChars(product, adapter.maxChars),
      recentReplies,
      feedback: revision.feedback,
      previousDraft: revision.previousDraft,
    }),
  });

  if (result.skip || !result.reply.trim()) return { skip: true, reason: result.skipReason || "model skipped" };
  return { skip: false, text: result.reply.trim() };
}

export function maxReplyChars(product: Product, platformMax: number): number {
  return Math.min(product.replyPolicy.maxChars, platformMax);
}
