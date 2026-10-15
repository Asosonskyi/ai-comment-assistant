import type { NeutralPost, SearchQuery, ThreadContext } from "../core/types";

export interface SearchOptions {
  searchType: "RECENT" | "TOP";
  since?: Date;
  mediaType?: "TEXT" | "IMAGE" | "VIDEO" | null;
  limit: number;
}

export interface OwnReply {
  replyId: string;
  repliedToId: string;
  rootId: string;
  text: string;
  url?: string;
  createdAt: Date;
}

export interface ReplyQuota {
  used: number;
  total: number;
}

// The only place that talks to a social network. Adding a platform means
// implementing this interface and registering it in core/registry.ts.
export interface PlatformAdapter {
  readonly platform: string;
  readonly maxChars: number;
  whoAmI(): Promise<{ userId: string; username: string }>;
  search(query: SearchQuery, options: SearchOptions): Promise<NeutralPost[]>;
  getThreadContext(post: NeutralPost): Promise<ThreadContext>;
  publishReply(postId: string, text: string): Promise<{ replyId: string; url?: string }>;
  getReplyQuota(): Promise<ReplyQuota | null>;
  listOwnReplies(since: Date): Promise<OwnReply[]>;
}

export type PlatformErrorKind = "rate_limited" | "auth" | "permission" | "restricted" | "not_connected" | "other";

export class PlatformError extends Error {
  constructor(
    readonly platform: string,
    readonly kind: PlatformErrorKind,
    message: string,
    readonly code?: number,
  ) {
    super(`${platform}: ${message}`);
    this.name = "PlatformError";
  }

  // Errors that mean the account should stop posting until a human looks at it.
  get shouldPause(): boolean {
    return this.kind === "rate_limited" || this.kind === "restricted" || this.kind === "permission" || this.kind === "auth";
  }
}
