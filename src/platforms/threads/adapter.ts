import { setTimeout as sleep } from "node:timers/promises";
import type { NeutralPost, PlatformCredentials, SearchQuery, ThreadContext } from "../../core/types";
import {
  PlatformError,
  type OwnReply,
  type PlatformAdapter,
  type ReplyQuota,
  type SearchOptions,
} from "../PlatformAdapter";
import { ThreadsClient } from "./client";

const POST_FIELDS = "id,text,username,permalink,timestamp,media_type,is_reply,root_post,replied_to";
const CONTEXT_REPLIES = 15;

interface ThreadsMedia {
  id: string;
  text?: string;
  username?: string;
  permalink?: string;
  timestamp?: string;
  media_type?: string;
  is_reply?: boolean;
  root_post?: string | { id: string };
  replied_to?: string | { id: string };
}

export class ThreadsAdapter implements PlatformAdapter {
  readonly platform = "threads";
  readonly maxChars = 500;
  private readonly client: ThreadsClient;

  constructor(private readonly getCredentials: () => Promise<PlatformCredentials | undefined>) {
    this.client = new ThreadsClient(async () => (await this.credentials()).accessToken);
  }

  async whoAmI() {
    const me = await this.client.get<{ id: string; username: string }>("me", { fields: "id,username" });
    return { userId: me.id, username: me.username };
  }

  async search(query: SearchQuery, options: SearchOptions): Promise<NeutralPost[]> {
    const result = await this.client.get<{ data?: ThreadsMedia[] }>("keyword_search", {
      q: query.q,
      search_mode: query.mode,
      search_type: options.searchType,
      media_type: options.mediaType ?? undefined,
      since: options.since ? Math.floor(options.since.getTime() / 1000) : undefined,
      limit: options.limit,
      fields: POST_FIELDS,
    });
    return (result.data ?? []).map(toNeutralPost);
  }

  async getThreadContext(post: NeutralPost): Promise<ThreadContext> {
    const root =
      post.rootId !== post.id
        ? toNeutralPost(await this.client.get<ThreadsMedia>(post.rootId, { fields: POST_FIELDS }))
        : undefined;
    const conversation = await this.client.get<{ data?: ThreadsMedia[] }>(`${post.rootId}/conversation`, {
      fields: POST_FIELDS,
      reverse: false,
    });
    const replies = (conversation.data ?? [])
      .map(toNeutralPost)
      .filter((reply) => reply.id !== post.id)
      .slice(0, CONTEXT_REPLIES);
    return { post, root, replies };
  }

  async publishReply(postId: string, text: string) {
    const { userId } = await this.credentials();
    const container = await this.client.post<{ id: string }>("me/threads", {
      media_type: "TEXT",
      text,
      reply_to_id: postId,
    });
    await this.waitForContainer(container.id);
    const published = await this.client.post<{ id: string }>(`${userId}/threads_publish`, {
      creation_id: container.id,
    });
    const media = await this.client
      .get<{ permalink?: string }>(published.id, { fields: "permalink" })
      .catch(() => ({ permalink: undefined }));
    return { replyId: published.id, url: media.permalink };
  }

  async getReplyQuota(): Promise<ReplyQuota | null> {
    const { userId } = await this.credentials();
    const result = await this.client.get<{
      data?: { reply_quota_usage?: number; reply_config?: { quota_total?: number } }[];
    }>(`${userId}/threads_publishing_limit`, { fields: "reply_quota_usage,reply_config" });
    const row = result.data?.[0];
    if (row?.reply_quota_usage === undefined || row.reply_config?.quota_total === undefined) return null;
    return { used: row.reply_quota_usage, total: row.reply_config.quota_total };
  }

  async listOwnReplies(since: Date): Promise<OwnReply[]> {
    const items = await this.client.getAll<ThreadsMedia>(
      "me/replies",
      { fields: POST_FIELDS, since: Math.floor(since.getTime() / 1000), limit: 100 },
      5,
    );
    return items
      .filter((item) => item.is_reply)
      .map((item) => {
        const post = toNeutralPost(item);
        return {
          replyId: post.id,
          repliedToId: refId(item.replied_to) ?? post.rootId,
          rootId: post.rootId,
          text: post.text,
          url: post.url,
          createdAt: post.createdAt,
        };
      });
  }

  // Text containers are usually ready at once; Meta recommends waiting before publishing otherwise.
  private async waitForContainer(containerId: string) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const status = await this.client.get<{ status?: string; error_message?: string }>(containerId, {
        fields: "status,error_message",
      });
      if (status.status === "FINISHED" || status.status === undefined) return;
      if (status.status === "ERROR" || status.status === "EXPIRED") {
        throw new PlatformError("threads", "other", `reply container ${status.status}: ${status.error_message ?? ""}`);
      }
      await sleep(3000);
    }
    throw new PlatformError("threads", "other", "reply container was not ready after 30s");
  }

  private async credentials(): Promise<PlatformCredentials> {
    const credentials = await this.getCredentials();
    if (!credentials) throw new PlatformError("threads", "not_connected", "account not connected (log in via /auth/threads)");
    return credentials;
  }
}

function refId(ref: string | { id: string } | undefined): string | undefined {
  return typeof ref === "string" ? ref : ref?.id;
}

export function toNeutralPost(media: ThreadsMedia): NeutralPost {
  return {
    platform: "threads",
    id: media.id,
    authorHandle: media.username ?? "",
    text: media.text ?? "",
    url: media.permalink,
    // Threads timestamps look like 2024-01-01T18:20:00+0000.
    createdAt: new Date((media.timestamp ?? "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2")),
    isReply: media.is_reply ?? false,
    rootId: (media.is_reply ? refId(media.root_post) : undefined) ?? media.id,
  };
}
