import type { Product } from "../config/productSchema";
import { publishDraft } from "../modules/publisher";
import { replyCapacity } from "../modules/safety";
import { errorMessage, type AppContext } from "./context";

const MINUTE = 60_000;

// One queue per product/account. Approved drafts are posted one at a time,
// spaced by minGapMinutes plus random jitter, and held while paused or capped.
export class PublishQueue {
  private queues = new Map<string, string[]>();
  private timers = new Map<string, NodeJS.Timeout>();
  private nextAt = new Map<string, number>();
  private busy = new Set<string>();
  private capNotified = new Set<string>();

  constructor(
    private readonly ctx: AppContext,
    private readonly random: () => number = Math.random,
  ) {}

  size(productId: string): number {
    return this.queues.get(productId)?.length ?? 0;
  }

  // Called on boot with the newest reply found on the platform, so a restart doesn't post in a burst.
  seedLastPublished(product: Product, at: Date) {
    const next = at.getTime() + product.replyPolicy.minGapMinutes * MINUTE;
    this.nextAt.set(product.id, Math.max(this.nextAt.get(product.id) ?? 0, next));
  }

  enqueue(product: Product, draftId: string): { position: number; earliest: Date } {
    const queue = this.queues.get(product.id) ?? [];
    queue.push(draftId);
    this.queues.set(product.id, queue);
    this.schedule(product.id);
    const gap = product.replyPolicy.minGapMinutes * MINUTE;
    const start = Math.max(Date.now(), this.nextAt.get(product.id) ?? 0);
    return { position: queue.length, earliest: new Date(start + (queue.length - 1) * gap) };
  }

  // Resume processing (e.g. after POST /products/:id/resume).
  kick(productId: string) {
    this.schedule(productId);
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(productId: string) {
    if (this.timers.has(productId) || this.busy.has(productId) || this.size(productId) === 0) return;
    const wait = Math.max(0, (this.nextAt.get(productId) ?? 0) - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(productId);
      void this.process(productId);
    }, wait);
    timer.unref?.();
    this.timers.set(productId, timer);
  }

  private async process(productId: string) {
    const product = this.ctx.products.get(productId);
    const queue = this.queues.get(productId);
    if (!product || !queue?.length) return;
    this.busy.add(productId);
    let reschedule = true;
    try {
      if (await this.ctx.store.getPausedReason(productId)) {
        reschedule = false; // resume() calls kick()
        return;
      }

      const capacity = await replyCapacity(product, this.ctx, 0);
      if (capacity.remaining <= 0) {
        const retryAt = capacity.nextSlotAt ?? new Date(Date.now() + 60 * MINUTE);
        this.nextAt.set(productId, retryAt.getTime());
        if (!this.capNotified.has(productId)) {
          this.capNotified.add(productId);
          await this.ctx.registry
            .approval(product)
            .notify(product, `⏳ ${product.name}: ${capacity.reason}. ${queue.length} approved repl(ies) wait until ${retryAt.toISOString()}.`);
        }
        return;
      }
      this.capNotified.delete(productId);

      const draftId = queue.shift()!;
      const draft = await this.ctx.store.getDraft(draftId);
      if (draft?.status === "queued") await publishDraft(product, draft, this.ctx);

      const { minGapMinutes, jitterMinutes } = product.replyPolicy;
      this.nextAt.set(productId, Date.now() + (minGapMinutes + this.random() * jitterMinutes) * MINUTE);
    } catch (err) {
      this.ctx.log.error({ product: productId, err: errorMessage(err) }, "publish queue error");
      this.nextAt.set(productId, Date.now() + 5 * MINUTE);
    } finally {
      this.busy.delete(productId);
      if (reschedule) this.schedule(productId);
    }
  }
}
