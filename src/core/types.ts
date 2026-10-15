// Platform-neutral data shapes shared by all pipeline modules.

export interface NeutralPost {
  platform: string;
  id: string;
  authorHandle: string;
  text: string;
  url?: string;
  createdAt: Date;
  isReply: boolean;
  // Id of the top-level post of the conversation (equals `id` for top-level posts).
  rootId: string;
}

export interface ThreadContext {
  post: NeutralPost;
  // Top-level post when `post` is itself a reply.
  root?: NeutralPost;
  // A sample of other replies in the conversation, oldest first.
  replies: NeutralPost[];
}

export type SearchMode = "KEYWORD" | "TAG";

export interface SearchQuery {
  q: string;
  mode: SearchMode;
}

export interface Candidate {
  post: NeutralPost;
  relevance: number;
  isAskingForHelp: boolean;
  reason: string;
}

export interface SafetyResult {
  ok: boolean;
  reasons: string[];
}

export type DraftStatus =
  | "pending_approval"
  | "queued"
  | "published"
  | "rejected"
  | "blocked"
  | "failed";

export interface Draft {
  id: string;
  productId: string;
  runId: string;
  candidate: Candidate;
  text: string;
  status: DraftStatus;
  feedback: string[];
  safety?: SafetyResult;
  approvalRef?: { chatId: number | string; messageId: number };
  reply?: { id: string; url?: string };
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReplyRecord {
  productId: string;
  platform: string;
  replyId: string;
  repliedToId: string;
  rootId: string;
  text: string;
  url?: string;
  publishedAt: Date;
  // "app" = published by this server; "platform" = loaded from the account's history on boot.
  source: "app" | "platform";
}

export type RunStatus = "running" | "completed" | "failed";

export interface Run {
  id: string;
  productId: string;
  status: RunStatus;
  startedAt: Date;
  finishedAt?: Date;
  queries: SearchQuery[];
  counts: {
    found: number;
    filteredOut: number;
    ranked: number;
    drafted: number;
    blocked: number;
    sentForApproval: number;
  };
  blocked: { postId: string; reasons: string[] }[];
  draftIds: string[];
  errors: string[];
}

export interface PlatformCredentials {
  accessToken: string;
  userId: string;
  username: string;
  expiresAt?: Date;
  source: "oauth" | "env";
  obtainedAt: Date;
}
