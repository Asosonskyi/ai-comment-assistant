import type { Product } from "../config/productSchema";
import { errorMessage, type AppContext } from "../core/context";
import type { Draft } from "../core/types";
import { PlatformError } from "../platforms/PlatformAdapter";

// Module 8: post an approved draft, record it, and pause the account on platform warnings.
export async function publishDraft(product: Product, draft: Draft, ctx: AppContext): Promise<void> {
  const approval = ctx.registry.approval(product);
  const post = draft.candidate.post;

  // Final guard: something may have changed since approval (another reply, a restart re-seed).
  if (await ctx.store.hasRepliedInConversation(product.id, post.rootId)) {
    await finish(draft, "failed", ctx, "already replied in this conversation");
    await approval.closeCard(product, draft, "⚠️ Not published: already replied in this conversation");
    return;
  }

  try {
    const reply = await ctx.registry.adapter(product).publishReply(post.id, draft.text);
    await ctx.store.addReply({
      productId: product.id,
      platform: post.platform,
      replyId: reply.replyId,
      repliedToId: post.id,
      rootId: post.rootId,
      text: draft.text,
      url: reply.url,
      publishedAt: new Date(),
      source: "app",
    });
    draft.reply = { id: reply.replyId, url: reply.url };
    await finish(draft, "published", ctx);
    ctx.log.info({ product: product.id, draftId: draft.id, replyId: reply.replyId }, "reply published");
    await approval.closeCard(product, draft, `✅ Published${reply.url ? `: ${reply.url}` : ""}`);
  } catch (err) {
    await finish(draft, "failed", ctx, errorMessage(err));
    ctx.log.error({ product: product.id, draftId: draft.id, err: errorMessage(err) }, "publish failed");
    await approval.closeCard(product, draft, `❌ Publish failed: ${errorMessage(err)}`);
    if (err instanceof PlatformError && err.shouldPause) {
      const reason = `${err.kind}: ${err.message}`;
      await ctx.store.setPaused(product.id, reason);
      await approval.notify(
        product,
        `⏸ ${product.name} paused after a platform warning (${reason}). Check the account, then POST /products/${product.id}/resume.`,
      );
    }
  }
}

async function finish(draft: Draft, status: Draft["status"], ctx: AppContext, error?: string) {
  draft.status = status;
  draft.error = error;
  draft.updatedAt = new Date();
  await ctx.store.saveDraft(draft);
}
