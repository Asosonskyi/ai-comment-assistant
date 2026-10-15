import type { Draft, PlatformCredentials, ReplyRecord, Run } from "../core/types";

// All state lives behind this interface. The POC uses MemoryStore; a Postgres
// implementation can replace it without touching the pipeline modules.
export interface Store {
  saveRun(run: Run): Promise<void>;
  getRun(runId: string): Promise<Run | undefined>;
  getActiveRun(productId: string): Promise<Run | undefined>;

  markSeen(productId: string, postIds: string[]): Promise<void>;
  isSeen(productId: string, postId: string): Promise<boolean>;

  saveDraft(draft: Draft): Promise<void>;
  getDraft(draftId: string): Promise<Draft | undefined>;
  countDrafts(productId: string, status: Draft["status"]): Promise<number>;

  addReply(record: ReplyRecord): Promise<void>;
  listReplies(productId: string): Promise<ReplyRecord[]>;
  hasRepliedTo(productId: string, postId: string): Promise<boolean>;
  hasRepliedInConversation(productId: string, rootId: string): Promise<boolean>;
  countRepliesSince(productId: string, since: Date): Promise<number>;

  setPaused(productId: string, reason: string | null): Promise<void>;
  getPausedReason(productId: string): Promise<string | null>;

  setCredentials(productId: string, credentials: PlatformCredentials | null): Promise<void>;
  getCredentials(productId: string): Promise<PlatformCredentials | undefined>;
  listCredentials(): Promise<[string, PlatformCredentials][]>;
}
