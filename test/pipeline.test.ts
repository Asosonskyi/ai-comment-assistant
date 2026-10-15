import { describe, expect, it, vi } from "vitest";
import { DraftReview } from "../src/core/approvalActions";
import { Pipeline, RunRejectedError } from "../src/core/pipeline";
import { PublishQueue } from "../src/core/publishQueue";
import { PlatformError } from "../src/platforms/PlatformAdapter";
import { makeContext, makePost, makeProduct } from "./fixtures";

const product = makeProduct({
  replyPolicy: { minGapMinutes: 0, jitterMinutes: 0 },
  filters: { maxDraftsPerRun: 2, minRelevance: 0.5 },
});

async function setup() {
  const env = await makeContext(product);
  const queue = new PublishQueue(env.ctx, () => 0);
  const pipeline = new Pipeline(env.ctx, queue);
  const review = new DraftReview(env.ctx, queue);
  env.adapter.posts = [makePost("p1"), makePost("p2"), makePost("p3")];
  return { ...env, queue, pipeline, review };
}

async function runOnce(pipeline: Pipeline) {
  const run = await pipeline.startRun(product);
  await vi.waitFor(async () => expect(run.status).not.toBe("running"));
  return run;
}

describe("pipeline end to end", () => {
  it("plans, discovers, ranks, drafts and sends safe drafts for approval", async () => {
    const { pipeline, approval, adapter, llm } = await setup();
    const run = await runOnce(pipeline);

    expect(run.status).toBe("completed");
    expect(adapter.searches.map((query) => query.q)).toEqual(["breakfast ideas", "what to eat in the morning"]);
    expect(run.counts).toMatchObject({ found: 3, ranked: 3, drafted: 2, sentForApproval: 2, blocked: 0 });
    expect(approval.sent.map((draft) => draft.candidate.post.id)).toEqual(["p1", "p2"]);
    expect(llm.calls.map((call) => call.schemaName)).toContain("moderation");
    expect(approval.notices.at(-1)).toContain("sent for approval 2");
  });

  it("publishes approved drafts, records them, and skips those posts next run", async () => {
    const { pipeline, approval, adapter, review, store } = await setup();
    await runOnce(pipeline);
    const [first, second] = approval.sent;

    expect(await review.approve(first!.id)).toContain("Approved, queued #1");
    expect(await review.reject(second!.id)).toBe("Rejected.");
    expect(await review.approve(first!.id)).toBe("Draft is already queued.");

    await vi.waitFor(() => expect(adapter.published).toHaveLength(1));
    expect(adapter.published[0]).toEqual({ postId: "p1", text: first!.text });
    await vi.waitFor(async () => expect((await store.getDraft(first!.id))?.status).toBe("published"));
    expect(await store.hasRepliedInConversation(product.id, "p1")).toBe(true);
    expect(approval.closed.map((item) => item.status)).toEqual(
      expect.arrayContaining([expect.stringContaining("Published"), "🚫 Rejected"]),
    );

    // p1 replied, p2 rejected (seen); only p3 is left.
    approval.sent = [];
    await runOnce(pipeline);
    expect(approval.sent.map((draft) => draft.candidate.post.id)).toEqual(["p3"]);
  });

  it("blocks unsafe drafts and reports why", async () => {
    const { pipeline, approval, llm } = await setup();
    llm.handlers.reply_draft = () => ({ skip: false, skipReason: "", reply: "Get Yollly now at yollly.com #breakfast" });
    const run = await runOnce(pipeline);
    expect(approval.sent).toHaveLength(0);
    expect(run.counts.blocked).toBe(2);
    expect(run.blocked[0]?.reasons).toEqual(expect.arrayContaining(["contains a link or domain", "contains a hashtag"]));
  });

  it("redrafts with feedback and rejects unsafe edits", async () => {
    const { pipeline, approval, llm, review } = await setup();
    await runOnce(pipeline);
    const draft = approval.sent[0]!;

    expect(await review.edit(draft.id, "Check yollly.com")).toMatch(/^Edit not accepted: .*contains a link/);

    llm.handlers.reply_draft = (request) => {
      expect(request.user).toContain("Reviewer feedback to apply:\n- mention eggs");
      return { skip: false, skipReason: "", reply: "Eggs on toast with spinach is fast and filling. Yollly has lots of egg ideas." };
    };
    expect(await review.redraft(draft.id, "mention eggs")).toBe("New draft sent.");
    expect(approval.sent.at(-1)?.text).toContain("Eggs on toast");

    expect(await review.edit(draft.id, "Shakshuka is a great weekend option, and Yollly can plan the shopping list.")).toContain(
      "Edited and approved",
    );
  });

  it("pauses the product when the platform reports a restriction", async () => {
    const { pipeline, approval, adapter, review, store } = await setup();
    await runOnce(pipeline);
    adapter.publishError = new PlatformError("fake", "restricted", "action blocked", 368);

    await review.approve(approval.sent[0]!.id);
    await vi.waitFor(async () => expect(await store.getPausedReason(product.id)).toContain("restricted"));
    expect(approval.notices.at(-1)).toContain("paused");
    await expect(pipeline.startRun(product)).rejects.toBeInstanceOf(RunRejectedError);
  });

  it("refuses to start without credentials or while a run is active", async () => {
    const { pipeline, store } = await setup();
    const first = await pipeline.startRun(product);
    await expect(pipeline.startRun(product)).rejects.toThrow("already in progress");
    await vi.waitFor(() => expect(first.status).not.toBe("running"));

    await store.setCredentials(product.id, null);
    await expect(pipeline.startRun(product)).rejects.toThrow(/not connected/);
  });
});
