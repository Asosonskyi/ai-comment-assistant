import { describe, expect, it } from "vitest";
import { applyRules, rankPosts, type RuleContext } from "../src/modules/filterRank";
import { makeContext, makePost, makeProduct } from "./fixtures";

function rules(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    ownUsername: "yollly",
    isSeen: async () => false,
    hasRepliedTo: async () => false,
    hasRepliedInConversation: async () => false,
    now: new Date(),
    ...overrides,
  };
}

describe("applyRules", () => {
  const product = makeProduct({ filters: { excludeKeywords: ["sponsored"], excludeAuthors: ["@spammer"] } });

  it("drops own, seen, replied, excluded, duplicate-conversation and old posts", async () => {
    const posts = [
      makePost("ok"),
      makePost("own", { authorHandle: "Yollly" }),
      makePost("seen"),
      makePost("replied-conv", { rootId: "root-1" }),
      makePost("spam", { authorHandle: "spammer" }),
      makePost("ad", { text: "Sponsored breakfast post" }),
      makePost("old", { createdAt: new Date(Date.now() - 48 * 3600_000) }),
      makePost("same-conv", { rootId: "ok" }),
      makePost("empty", { text: "  " }),
    ];
    const { kept, dropped } = await applyRules(
      posts,
      product,
      rules({ isSeen: async (id) => id === "seen", hasRepliedInConversation: async (root) => root === "root-1" }),
    );
    expect(kept.map((post) => post.id)).toEqual(["ok"]);
    expect(Object.fromEntries(dropped.map((item) => [item.post.id, item.reason]))).toEqual({
      own: "own post",
      seen: "already seen",
      "replied-conv": "already replied in conversation",
      spam: "excluded author",
      ad: "excluded keyword",
      old: "too old",
      "same-conv": "another post from the same conversation kept",
      empty: "empty text",
    });
  });

  it("keeps own posts when includeOwnPosts is on (Threads dev mode)", async () => {
    const devProduct = makeProduct({ discovery: { topicDescription: "breakfast questions", includeOwnPosts: true } });
    const { kept } = await applyRules([makePost("own", { authorHandle: "yollly" })], devProduct, rules());
    expect(kept).toHaveLength(1);
  });
});

describe("rankPosts", () => {
  it("drops sensitive and low-relevance posts, sorts, and leaves overflow unseen", async () => {
    const product = makeProduct({ filters: { minRelevance: 0.5, maxDraftsPerRun: 2 } });
    const { ctx, llm } = await makeContext(product);
    const scores: Record<string, { relevance: number; sensitive?: boolean }> = {
      a: { relevance: 0.6 },
      b: { relevance: 0.95 },
      c: { relevance: 0.9, sensitive: true },
      d: { relevance: 0.2 },
      e: { relevance: 0.8 },
    };
    llm.handlers.post_ranking = () => ({
      results: Object.entries(scores).map(([id, score]) => ({
        id,
        relevance: score.relevance,
        isAskingForHelp: true,
        sensitive: score.sensitive ?? false,
        reason: "r",
      })),
    });

    const { selected, rejected, overflow } = await rankPosts(Object.keys(scores).map((id) => makePost(id)), product, ctx);
    expect(selected.map((candidate) => candidate.post.id)).toEqual(["b", "e"]);
    expect(overflow.map((post) => post.id)).toEqual(["a"]);
    expect(rejected.map((post) => post.id).sort()).toEqual(["c", "d"]);
  });
});
