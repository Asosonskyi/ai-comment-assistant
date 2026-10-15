import type { Product } from "../config/productSchema";
import { errorMessage, type AppContext } from "../core/context";
import type { NeutralPost, SafetyResult } from "../core/types";
import { ModerationSchema, moderatePrompt } from "../prompts/moderate";
import { maxSimilarity } from "../util/similarity";
import { maxReplyChars } from "./drafter";

const LINK_PATTERN = /(https?:\/\/|www\.)\S+|\b[\p{L}\p{N}-]+\.(com|net|org|io|app|co|ai|dev|me|ly|so|xyz|ua)\b/iu;
const HASHTAG_PATTERN = /(^|\s)#[\p{L}\p{N}_]+/u;
const MENTION_PATTERN = /(^|\s)@[\w.]+/u;
const DAY_MS = 24 * 3600_000;
// Stop before the platform's own rolling quota is exhausted.
const PLATFORM_QUOTA_MARGIN = 10;

export interface RuleCheckInput {
  text: string;
  product: Product;
  maxChars: number;
  recentReplyTexts: string[];
  alreadyRepliedToPost: boolean;
  alreadyRepliedInConversation: boolean;
}

// Module 6a: deterministic checks. Pure, so they are unit-tested directly.
export function checkRules(input: RuleCheckInput): string[] {
  const { text, product } = input;
  const reasons: string[] = [];

  if (!text.trim()) reasons.push("empty reply");
  if ([...text].length > input.maxChars) reasons.push(`too long (${[...text].length}/${input.maxChars} chars)`);
  if (!product.replyPolicy.allowLinks && LINK_PATTERN.test(text)) reasons.push("contains a link or domain");
  if (HASHTAG_PATTERN.test(text)) reasons.push("contains a hashtag");
  if (MENTION_PATTERN.test(text)) reasons.push("contains an @mention");
  if (!text.toLowerCase().includes(product.name.toLowerCase())) reasons.push(`does not mention ${product.name}`);

  const lower = text.toLowerCase();
  for (const phrase of product.replyPolicy.bannedPhrases) {
    if (lower.includes(phrase.toLowerCase())) reasons.push(`contains banned phrase "${phrase}"`);
  }

  const similar = maxSimilarity(text, input.recentReplyTexts);
  if (similar >= product.replyPolicy.maxSimilarity) {
    reasons.push(`too similar to a recent reply (${similar.toFixed(2)})`);
  }
  if (input.alreadyRepliedToPost) reasons.push("already replied to this post");
  if (input.alreadyRepliedInConversation) reasons.push("already replied in this conversation");
  return reasons;
}

// Module 6: rules + LLM moderation for a draft that is about to go to approval (or to be published).
export async function runSafetyChecks(
  product: Product,
  post: NeutralPost,
  text: string,
  ctx: AppContext,
): Promise<SafetyResult> {
  const adapter = ctx.registry.adapter(product);
  const recentReplyTexts = (await ctx.store.listReplies(product.id)).slice(-50).map((reply) => reply.text);
  const reasons = checkRules({
    text,
    product,
    maxChars: maxReplyChars(product, adapter.maxChars),
    recentReplyTexts,
    alreadyRepliedToPost: await ctx.store.hasRepliedTo(product.id, post.id),
    alreadyRepliedInConversation: await ctx.store.hasRepliedInConversation(product.id, post.rootId),
  });

  // Skip the LLM call when the rules already failed.
  if (reasons.length === 0) {
    try {
      const { provider, choice } = ctx.registry.llm(product, "moderate");
      const verdict = await provider.generateJson(ModerationSchema, "moderation", {
        model: choice.model,
        effort: choice.effort,
        ...moderatePrompt(product, post, text),
      });
      if (!verdict.safe) reasons.push(...(verdict.issues.length ? verdict.issues : ["flagged by moderation"]));
    } catch (err) {
      reasons.push(`moderation unavailable: ${errorMessage(err)}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export interface Capacity {
  remaining: number;
  // When the oldest reply in the 24h window ages out (only set when remaining is 0).
  nextSlotAt?: Date;
  reason?: string;
}

// How many more replies this account may publish right now, from our own log and the platform quota.
export async function replyCapacity(product: Product, ctx: AppContext, queued: number, now = new Date()): Promise<Capacity> {
  const windowStart = new Date(now.getTime() - DAY_MS);
  const replies = (await ctx.store.listReplies(product.id)).filter((reply) => reply.publishedAt >= windowStart);
  let remaining = product.replyPolicy.dailyCap - replies.length - queued;
  let reason = remaining <= 0 ? `daily cap of ${product.replyPolicy.dailyCap} reached` : undefined;

  try {
    const quota = await ctx.registry.adapter(product).getReplyQuota();
    if (quota) {
      const platformRemaining = quota.total - PLATFORM_QUOTA_MARGIN - quota.used - queued;
      if (platformRemaining < remaining) {
        remaining = platformRemaining;
        reason = `platform reply quota nearly used (${quota.used}/${quota.total})`;
      }
    }
  } catch (err) {
    ctx.log.warn({ product: product.id, err: errorMessage(err) }, "could not read platform reply quota");
  }

  if (remaining > 0) return { remaining };
  const oldest = replies[0];
  return {
    remaining: 0,
    reason,
    nextSlotAt: oldest ? new Date(oldest.publishedAt.getTime() + DAY_MS) : new Date(now.getTime() + 3600_000),
  };
}
