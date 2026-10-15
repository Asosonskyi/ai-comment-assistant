import { describe, expect, it } from "vitest";
import { checkRules, replyCapacity, type RuleCheckInput } from "../src/modules/safety";
import { makeContext, makeProduct } from "./fixtures";

const product = makeProduct({ replyPolicy: { bannedPhrases: ["download now"], dailyCap: 3 } });

function input(text: string, overrides: Partial<RuleCheckInput> = {}): RuleCheckInput {
  return {
    text,
    product,
    maxChars: 120,
    recentReplyTexts: [],
    alreadyRepliedToPost: false,
    alreadyRepliedInConversation: false,
    ...overrides,
  };
}

describe("checkRules", () => {
  it("passes a short, clean reply that names the product", () => {
    expect(checkRules(input("Overnight oats save my mornings. Yollly can suggest ideas from what you have."))).toEqual([]);
  });

  it("blocks links and bare domains when links are not allowed", () => {
    expect(checkRules(input("Try Yollly at https://yollly.com"))).toContain("contains a link or domain");
    expect(checkRules(input("Try Yollly, yollly.com"))).toContain("contains a link or domain");
  });

  it("allows links when the product allows them", () => {
    const withLinks = makeProduct({ replyPolicy: { allowLinks: true } });
    expect(checkRules(input("Try Yollly at yollly.com", { product: withLinks }))).toEqual([]);
  });

  it("blocks length, hashtags, mentions, banned phrases and a missing product name", () => {
    const reasons = checkRules(input(`${"a".repeat(130)} #breakfast @someone download now`));
    expect(reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("too long"),
        "contains a hashtag",
        "contains an @mention",
        'contains banned phrase "download now"',
        "does not mention Yollly",
      ]),
    );
  });

  it("blocks near-duplicates of recent replies", () => {
    const recent = ["Overnight oats save my mornings. Yollly can suggest ideas from what you have."];
    const reasons = checkRules(input("Overnight oats save my mornings! Yollly can suggest ideas from what you have.", { recentReplyTexts: recent }));
    expect(reasons.some((reason) => reason.startsWith("too similar"))).toBe(true);
  });

  it("enforces one reply per post and per conversation", () => {
    const reasons = checkRules(input("Yollly helps.", { alreadyRepliedToPost: true, alreadyRepliedInConversation: true }));
    expect(reasons).toEqual(["already replied to this post", "already replied in this conversation"]);
  });
});

describe("replyCapacity", () => {
  it("counts replies in the last 24h and queued drafts against the daily cap", async () => {
    const { ctx, store } = await makeContext(product);
    const now = new Date();
    for (const [index, hoursAgo] of [1, 2, 30].entries()) {
      await store.addReply({
        productId: product.id,
        platform: "fake",
        replyId: `r${index}`,
        repliedToId: `p${index}`,
        rootId: `p${index}`,
        text: "x",
        publishedAt: new Date(now.getTime() - hoursAgo * 3600_000),
        source: "app",
      });
    }
    expect((await replyCapacity(product, ctx, 0, now)).remaining).toBe(1);

    const full = await replyCapacity(product, ctx, 1, now);
    expect(full.remaining).toBe(0);
    expect(full.reason).toContain("daily cap");
    // The oldest reply inside the window (2h ago) frees a slot 22h from now.
    expect(full.nextSlotAt?.getTime()).toBe(now.getTime() + 22 * 3600_000);
  });
});
