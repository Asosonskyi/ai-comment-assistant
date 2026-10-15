import type { ApprovalActions } from "../approval/ApprovalChannel";
import type { Product } from "../config/productSchema";
import { writeDraft } from "../modules/drafter";
import { runSafetyChecks } from "../modules/safety";
import { errorMessage, type AppContext } from "./context";
import type { PublishQueue } from "./publishQueue";
import type { Draft } from "./types";

// Human decisions on drafts (module 7). Approved or edited drafts go to the publish queue (module 8);
// redrafts go back through modules 5 and 6.
export class DraftReview implements ApprovalActions {
  constructor(
    private readonly ctx: AppContext,
    private readonly queue: PublishQueue,
  ) {}

  async approve(draftId: string): Promise<string> {
    const loaded = await this.load(draftId);
    if (typeof loaded === "string") return loaded;
    const { draft, product } = loaded;
    return this.enqueue(product, draft, "👍 Approved");
  }

  async reject(draftId: string): Promise<string> {
    const loaded = await this.load(draftId);
    if (typeof loaded === "string") return loaded;
    const { draft, product } = loaded;
    await this.save(draft, "rejected");
    await this.ctx.registry.approval(product).closeCard(product, draft, "🚫 Rejected");
    return "Rejected.";
  }

  async edit(draftId: string, text: string): Promise<string> {
    const loaded = await this.load(draftId);
    if (typeof loaded === "string") return loaded;
    const { draft, product } = loaded;
    const safety = await runSafetyChecks(product, draft.candidate.post, text.trim(), this.ctx);
    if (!safety.ok) return `Edit not accepted: ${safety.reasons.join("; ")}. Tap Edit to try again.`;
    draft.text = text.trim();
    draft.safety = safety;
    return this.enqueue(product, draft, "✏️ Edited and approved");
  }

  async redraft(draftId: string, feedback: string): Promise<string> {
    const loaded = await this.load(draftId);
    if (typeof loaded === "string") return loaded;
    const { draft, product } = loaded;
    const approval = this.ctx.registry.approval(product);

    draft.feedback.push(feedback.trim());
    let result;
    try {
      result = await writeDraft(product, draft.candidate, this.ctx, { feedback: draft.feedback, previousDraft: draft.text });
    } catch (err) {
      return `Redraft failed: ${errorMessage(err)}`;
    }
    if (result.skip) return `The model chose not to reply: ${result.reason}. Approve the current draft, edit it, or reject.`;

    const safety = await runSafetyChecks(product, draft.candidate.post, result.text, this.ctx);
    if (!safety.ok) {
      return `New draft blocked (${safety.reasons.join("; ")}):\n${result.text}\n\nTap Redraft again or Edit.`;
    }

    await approval.closeCard(product, draft, "🔁 Redrafted, see the new card below");
    draft.text = result.text;
    draft.safety = safety;
    draft.approvalRef = await approval.sendForApproval(product, draft);
    await this.save(draft, "pending_approval");
    return "New draft sent.";
  }

  private async enqueue(product: Product, draft: Draft, label: string): Promise<string> {
    await this.save(draft, "queued");
    const { position, earliest } = this.queue.enqueue(product, draft.id);
    const status = `${label}, queued #${position}, earliest ${earliest.toISOString().slice(11, 16)} UTC`;
    await this.ctx.registry.approval(product).closeCard(product, draft, status);
    return status;
  }

  private async load(draftId: string): Promise<{ draft: Draft; product: Product } | string> {
    const draft = await this.ctx.store.getDraft(draftId);
    if (!draft) return "Draft expired (server restarted or unknown id).";
    if (draft.status !== "pending_approval") return `Draft is already ${draft.status}.`;
    const product = this.ctx.products.get(draft.productId);
    if (!product) return `Unknown product ${draft.productId}.`;
    return { draft, product };
  }

  private async save(draft: Draft, status: Draft["status"]) {
    draft.status = status;
    draft.updatedAt = new Date();
    await this.ctx.store.saveDraft(draft);
  }
}
