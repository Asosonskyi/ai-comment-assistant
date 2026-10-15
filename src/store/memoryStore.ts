import type { Draft, PlatformCredentials, ReplyRecord, Run } from "../core/types";
import type { Store } from "./Store";

// In-memory state for the POC. Everything is lost on restart; boot recovery
// re-seeds replies from the platform so dedupe keeps working.
export class MemoryStore implements Store {
  private runs = new Map<string, Run>();
  private seen = new Map<string, Set<string>>();
  private drafts = new Map<string, Draft>();
  private replies = new Map<string, ReplyRecord[]>();
  private paused = new Map<string, string>();
  private credentials = new Map<string, PlatformCredentials>();

  async saveRun(run: Run) {
    this.runs.set(run.id, run);
  }

  async getRun(runId: string) {
    return this.runs.get(runId);
  }

  async getActiveRun(productId: string) {
    for (const run of this.runs.values()) {
      if (run.productId === productId && run.status === "running") return run;
    }
    return undefined;
  }

  async markSeen(productId: string, postIds: string[]) {
    const set = this.seen.get(productId) ?? new Set<string>();
    for (const id of postIds) set.add(id);
    this.seen.set(productId, set);
  }

  async isSeen(productId: string, postId: string) {
    return this.seen.get(productId)?.has(postId) ?? false;
  }

  async saveDraft(draft: Draft) {
    this.drafts.set(draft.id, draft);
  }

  async getDraft(draftId: string) {
    return this.drafts.get(draftId);
  }

  async countDrafts(productId: string, status: Draft["status"]) {
    let count = 0;
    for (const draft of this.drafts.values()) {
      if (draft.productId === productId && draft.status === status) count++;
    }
    return count;
  }

  async addReply(record: ReplyRecord) {
    const list = this.replies.get(record.productId) ?? [];
    if (list.some((existing) => existing.replyId === record.replyId)) return;
    list.push(record);
    list.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
    this.replies.set(record.productId, list);
  }

  async listReplies(productId: string) {
    return [...(this.replies.get(productId) ?? [])];
  }

  async hasRepliedTo(productId: string, postId: string) {
    return (this.replies.get(productId) ?? []).some((reply) => reply.repliedToId === postId);
  }

  async hasRepliedInConversation(productId: string, rootId: string) {
    return (this.replies.get(productId) ?? []).some((reply) => reply.rootId === rootId);
  }

  async countRepliesSince(productId: string, since: Date) {
    return (this.replies.get(productId) ?? []).filter((reply) => reply.publishedAt >= since).length;
  }

  async setPaused(productId: string, reason: string | null) {
    if (reason === null) this.paused.delete(productId);
    else this.paused.set(productId, reason);
  }

  async getPausedReason(productId: string) {
    return this.paused.get(productId) ?? null;
  }

  async setCredentials(productId: string, credentials: PlatformCredentials | null) {
    if (credentials === null) this.credentials.delete(productId);
    else this.credentials.set(productId, credentials);
  }

  async getCredentials(productId: string) {
    return this.credentials.get(productId);
  }

  async listCredentials() {
    return [...this.credentials.entries()];
  }
}
