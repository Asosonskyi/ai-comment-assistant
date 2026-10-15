import type { Product } from "../config/productSchema";
import type { AppContext } from "../core/context";
import type { Candidate, NeutralPost } from "../core/types";
import { RankSchema, rankPrompt } from "../prompts/rank";

const RANK_BATCH = 20;

export interface RuleContext {
  ownUsername?: string;
  isSeen: (postId: string) => Promise<boolean>;
  hasRepliedTo: (postId: string) => Promise<boolean>;
  hasRepliedInConversation: (rootId: string) => Promise<boolean>;
  now: Date;
}

// Module 4a: cheap rule filters before spending LLM tokens.
export async function applyRules(
  posts: NeutralPost[],
  product: Product,
  rules: RuleContext,
): Promise<{ kept: NeutralPost[]; dropped: { post: NeutralPost; reason: string }[] }> {
  const { discovery, filters } = product;
  const oldest = rules.now.getTime() - discovery.sinceHours * 3600_000;
  const excludedWords = filters.excludeKeywords.map((word) => word.toLowerCase());
  const excludedAuthors = new Set(filters.excludeAuthors.map((author) => author.replace(/^@/, "").toLowerCase()));
  const own = rules.ownUsername?.toLowerCase();

  const kept: NeutralPost[] = [];
  const dropped: { post: NeutralPost; reason: string }[] = [];
  const keptRoots = new Set<string>();

  for (const post of posts) {
    const text = post.text.toLowerCase();
    const author = post.authorHandle.toLowerCase();
    let reason: string | null = null;

    if (!post.text.trim()) reason = "empty text";
    else if (own && author === own && !discovery.includeOwnPosts) reason = "own post";
    else if (await rules.isSeen(post.id)) reason = "already seen";
    else if (await rules.hasRepliedTo(post.id)) reason = "already replied to post";
    else if (await rules.hasRepliedInConversation(post.rootId)) reason = "already replied in conversation";
    else if (keptRoots.has(post.rootId)) reason = "another post from the same conversation kept";
    else if (excludedAuthors.has(author)) reason = "excluded author";
    else if (excludedWords.some((word) => text.includes(word))) reason = "excluded keyword";
    else if (Number.isNaN(post.createdAt.getTime()) || post.createdAt.getTime() < oldest) reason = "too old";

    if (reason) dropped.push({ post, reason });
    else {
      kept.push(post);
      keptRoots.add(post.rootId);
    }
  }
  return { kept, dropped };
}

// Module 4b: LLM relevance scoring; returns the best candidates and every post that was rejected.
export async function rankPosts(
  posts: NeutralPost[],
  product: Product,
  ctx: AppContext,
): Promise<{ selected: Candidate[]; rejected: NeutralPost[]; overflow: NeutralPost[] }> {
  const { provider, choice } = ctx.registry.llm(product, "rank");
  const scored: (Candidate & { sensitive: boolean })[] = [];

  for (let i = 0; i < posts.length; i += RANK_BATCH) {
    const batch = posts.slice(i, i + RANK_BATCH);
    const result = await provider.generateJson(RankSchema, "post_ranking", {
      model: choice.model,
      effort: choice.effort,
      ...rankPrompt(product, batch),
    });
    const byId = new Map(result.results.map((row) => [row.id, row]));
    for (const post of batch) {
      const row = byId.get(post.id);
      scored.push({
        post,
        relevance: clamp(row?.relevance ?? 0),
        isAskingForHelp: row?.isAskingForHelp ?? false,
        sensitive: row?.sensitive ?? false,
        reason: row?.reason ?? "not scored",
      });
    }
  }

  const eligible = scored
    .filter((item) => !item.sensitive && item.relevance >= product.filters.minRelevance)
    .sort((a, b) => b.relevance - a.relevance || Number(b.isAskingForHelp) - Number(a.isAskingForHelp));
  const selected = eligible.slice(0, product.filters.maxDraftsPerRun).map(({ sensitive: _s, ...candidate }) => candidate);
  // Good posts beyond this run's limit stay unseen so a later run can pick them up.
  const overflow = eligible.slice(product.filters.maxDraftsPerRun).map((item) => item.post);
  const eligibleIds = new Set(eligible.map((item) => item.post.id));
  const rejected = scored.filter((item) => !eligibleIds.has(item.post.id)).map((item) => item.post);
  return { selected, rejected, overflow };
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
