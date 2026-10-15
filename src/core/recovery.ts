import type { Product } from "../config/productSchema";
import { errorMessage, type AppContext } from "./context";
import type { PublishQueue } from "./publishQueue";

const LOOKBACK_DAYS = 7;

// State is in memory, so after a restart (or a fresh login) load the account's own recent replies
// from the platform. Dedupe, the one-reply-per-conversation rule, caps and pacing then keep working.
export async function recoverReplyHistory(product: Product, ctx: AppContext, queue: PublishQueue): Promise<number> {
  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600_000);
    const replies = await ctx.registry.adapter(product).listOwnReplies(since);
    for (const reply of replies) {
      await ctx.store.addReply({
        productId: product.id,
        platform: product.platform.name,
        replyId: reply.replyId,
        repliedToId: reply.repliedToId,
        rootId: reply.rootId,
        text: reply.text,
        url: reply.url,
        publishedAt: reply.createdAt,
        source: "platform",
      });
    }
    const latest = replies.reduce<Date | undefined>(
      (max, reply) => (!max || reply.createdAt > max ? reply.createdAt : max),
      undefined,
    );
    if (latest) queue.seedLastPublished(product, latest);
    ctx.log.info({ product: product.id, replies: replies.length }, "reply history recovered");
    return replies.length;
  } catch (err) {
    ctx.log.warn({ product: product.id, err: errorMessage(err) }, "could not recover reply history");
    return 0;
  }
}
