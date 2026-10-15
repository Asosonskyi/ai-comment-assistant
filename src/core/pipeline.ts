import type { RunControl } from "../approval/ApprovalChannel";
import type { Product } from "../config/productSchema";
import { discoverPosts } from "../modules/discovery";
import { writeDraft } from "../modules/drafter";
import { applyRules, rankPosts } from "../modules/filterRank";
import { planQueries } from "../modules/queryPlanner";
import { replyCapacity, runSafetyChecks } from "../modules/safety";
import { PlatformError } from "../platforms/PlatformAdapter";
import { errorMessage, newId, type AppContext } from "./context";
import type { PublishQueue } from "./publishQueue";
import type { Candidate, Draft, Run } from "./types";

export class RunRejectedError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

// Orchestrates modules 2-6 for one run and hands safe drafts to the approval channel (module 7).
export class Pipeline {
  constructor(
    private readonly ctx: AppContext,
    private readonly queue: PublishQueue,
  ) {}

  // Validates preconditions, then runs the pipeline in the background.
  async startRun(product: Product): Promise<Run> {
    const { store } = this.ctx;
    if (product.approval.chatId === 0) {
      throw new RunRejectedError("approval.chatId is not set; send /chatid to the bot and put it in the product config", 412);
    }
    if (await store.getActiveRun(product.id)) throw new RunRejectedError("a run is already in progress", 409);
    const paused = await store.getPausedReason(product.id);
    if (paused) throw new RunRejectedError(`product is paused: ${paused}`, 409);
    if (!(await store.getCredentials(product.id))) {
      throw new RunRejectedError(`${product.platform.name} account not connected; log in via /auth/${product.platform.name}/${product.id}`, 412);
    }

    const run: Run = {
      id: newId(),
      productId: product.id,
      status: "running",
      startedAt: new Date(),
      queries: [],
      counts: { found: 0, filteredOut: 0, ranked: 0, drafted: 0, blocked: 0, sentForApproval: 0 },
      blocked: [],
      draftIds: [],
      errors: [],
    };
    await store.saveRun(run);
    void this.execute(product, run);
    return run;
  }

  async execute(product: Product, run: Run): Promise<Run> {
    const { store, log } = this.ctx;
    try {
      const capacity = await replyCapacity(product, this.ctx, this.queue.size(product.id));
      if (capacity.remaining <= 0) throw new Error(`no reply capacity: ${capacity.reason}`);

      run.queries = await planQueries(product, this.ctx);
      const discovered = await discoverPosts(product, run.queries, this.ctx);
      run.counts.found = discovered.posts.length;
      run.errors.push(...discovered.errors);

      const credentials = await store.getCredentials(product.id);
      const { kept, dropped } = await applyRules(discovered.posts, product, {
        ownUsername: credentials?.username,
        isSeen: (id) => store.isSeen(product.id, id),
        hasRepliedTo: (id) => store.hasRepliedTo(product.id, id),
        hasRepliedInConversation: (rootId) => store.hasRepliedInConversation(product.id, rootId),
        now: new Date(),
      });
      run.counts.filteredOut = dropped.length;
      await store.markSeen(product.id, dropped.map((item) => item.post.id));

      const ranked = kept.length ? await rankPosts(kept, product, this.ctx) : { selected: [], rejected: [], overflow: [] };
      run.counts.ranked = kept.length;
      // Only draft as many as the account can still publish; the rest stay unseen for later runs.
      const toDraft = ranked.selected.slice(0, capacity.remaining);
      await store.markSeen(product.id, [...ranked.rejected, ...toDraft.map((candidate) => candidate.post)].map((post) => post.id));

      for (const candidate of toDraft) {
        await this.draftCandidate(product, run, candidate);
      }

      run.status = "completed";
    } catch (err) {
      run.status = "failed";
      run.errors.push(errorMessage(err));
      log.error({ product: product.id, runId: run.id, err: errorMessage(err) }, "run failed");
      if (err instanceof PlatformError && err.shouldPause) {
        await store.setPaused(product.id, `${err.kind}: ${err.message}`);
      }
    } finally {
      run.finishedAt = new Date();
      await store.saveRun(run);
      await this.notifySummary(product, run);
    }
    return run;
  }

  private async draftCandidate(product: Product, run: Run, candidate: Candidate) {
    try {
      const result = await writeDraft(product, candidate, this.ctx);
      if (result.skip) {
        run.counts.blocked++;
        run.blocked.push({ postId: candidate.post.id, reasons: [`drafter skipped: ${result.reason}`] });
        return;
      }
      run.counts.drafted++;

      const safety = await runSafetyChecks(product, candidate.post, result.text, this.ctx);
      if (!safety.ok) {
        run.counts.blocked++;
        run.blocked.push({ postId: candidate.post.id, reasons: safety.reasons });
        return;
      }

      const now = new Date();
      const draft: Draft = {
        id: newId(),
        productId: product.id,
        runId: run.id,
        candidate,
        text: result.text,
        status: "pending_approval",
        feedback: [],
        safety,
        createdAt: now,
        updatedAt: now,
      };
      // Save before sending so a fast button press finds the draft.
      await this.ctx.store.saveDraft(draft);
      draft.approvalRef = await this.ctx.registry.approval(product).sendForApproval(product, draft);
      await this.ctx.store.saveDraft(draft);
      run.draftIds.push(draft.id);
      run.counts.sentForApproval++;
    } catch (err) {
      if (err instanceof PlatformError && err.shouldPause) throw err;
      run.errors.push(`post ${candidate.post.id}: ${errorMessage(err)}`);
    }
  }

  private async notifySummary(product: Product, run: Run) {
    const { counts } = run;
    const lines = [
      `${run.status === "completed" ? "🔎" : "⚠️"} ${product.name} run ${run.id} ${run.status}`,
      `queries ${run.queries.length} · found ${counts.found} · filtered ${counts.filteredOut} · ranked ${counts.ranked}`,
      `drafted ${counts.drafted} · blocked ${counts.blocked} · sent for approval ${counts.sentForApproval}`,
      ...run.errors.slice(0, 3).map((error) => `error: ${error}`),
    ];
    try {
      await this.ctx.registry.approval(product).notify(product, lines.join("\n"));
    } catch (err) {
      this.ctx.log.warn({ err: errorMessage(err) }, "could not send run summary");
    }
  }
}

// Lets approvers start runs from the approval channel (same preconditions as the HTTP endpoint).
export class RunLauncher implements RunControl {
  constructor(private readonly ctx: AppContext, private readonly pipeline: Pipeline) {}

  products() {
    return [...this.ctx.products.values()].map(({ id, name }) => ({ id, name }));
  }

  async startRun(productId: string): Promise<string> {
    const product = this.ctx.products.get(productId);
    if (!product) return "Unknown product.";
    try {
      const run = await this.pipeline.startRun(product);
      return `▶️ ${product.name} run ${run.id} started. A summary follows when it finishes.`;
    } catch (err) {
      if (err instanceof RunRejectedError) return `Cannot start: ${err.message}`;
      throw err;
    }
  }
}
