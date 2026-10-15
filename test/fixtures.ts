import type { z } from "zod";
import type { ApprovalActions, ApprovalChannel } from "../src/approval/ApprovalChannel";
import { ProductSchema, type Product } from "../src/config/productSchema";
import type { AppContext } from "../src/core/context";
import { Registry } from "../src/core/registry";
import type { Draft, NeutralPost, SearchQuery, ThreadContext } from "../src/core/types";
import type { LlmProvider, LlmRequest } from "../src/llm/LlmProvider";
import type { OwnReply, PlatformAdapter, ReplyQuota, SearchOptions } from "../src/platforms/PlatformAdapter";
import { MemoryStore } from "../src/store/memoryStore";

export const silentLog = { debug() {}, info() {}, warn() {}, error() {} } as unknown as AppContext["log"];

export function makeProduct(overrides: Record<string, unknown> = {}): Product {
  return ProductSchema.parse({
    id: "yollly",
    name: "Yollly",
    url: "https://yollly.com",
    pitch: "Yollly is a breakfast recipe app that suggests recipes from a photo of your ingredients.",
    platform: { name: "fake" },
    discovery: { topicDescription: "people asking what to eat for breakfast", keywords: ["breakfast ideas"] },
    llm: { default: { provider: "fake", model: "fake-model" } },
    approval: { channel: "fake", chatId: 123 },
    ...overrides,
  });
}

export function makePost(id: string, overrides: Partial<NeutralPost> = {}): NeutralPost {
  return {
    platform: "fake",
    id,
    authorHandle: `user_${id}`,
    text: `Any quick breakfast ideas? I'm so bored of toast (${id})`,
    url: `https://example.test/${id}`,
    createdAt: new Date(Date.now() - 3600_000),
    isReply: false,
    rootId: id,
    ...overrides,
  };
}

export class FakeAdapter implements PlatformAdapter {
  readonly platform = "fake";
  readonly maxChars = 500;
  posts: NeutralPost[] = [];
  published: { postId: string; text: string }[] = [];
  searches: SearchQuery[] = [];
  publishError?: Error;

  async whoAmI() {
    return { userId: "me-id", username: "yollly" };
  }
  async search(query: SearchQuery, _options: SearchOptions) {
    this.searches.push(query);
    return this.posts;
  }
  async getThreadContext(post: NeutralPost): Promise<ThreadContext> {
    return { post, replies: [] };
  }
  async publishReply(postId: string, text: string) {
    if (this.publishError) throw this.publishError;
    this.published.push({ postId, text });
    return { replyId: `reply-${postId}`, url: `https://example.test/reply-${postId}` };
  }
  async getReplyQuota(): Promise<ReplyQuota | null> {
    return { used: 0, total: 1000 };
  }
  async listOwnReplies(_since: Date): Promise<OwnReply[]> {
    return [];
  }
}

type Handler = (request: LlmRequest) => unknown;

// Answers by schema name, so each test scripts only the stages it cares about.
export class FakeLlm implements LlmProvider {
  readonly name = "fake";
  calls: { schemaName: string; request: LlmRequest }[] = [];
  handlers: Record<string, Handler> = {
    query_plan: () => ({ queries: [{ q: "what to eat in the morning", mode: "KEYWORD" }] }),
    post_ranking: (request) => ({
      results: [...request.user.matchAll(/<post id="([^"]+)"/g)].map((match) => ({
        id: match[1],
        relevance: 0.9,
        isAskingForHelp: true,
        sensitive: false,
        reason: "asks for breakfast ideas",
      })),
    }),
    reply_draft: (request) => {
      const id = /<post id="([^"]+)"/.exec(request.user)?.[1] ?? "x";
      const ideas = [
        "Overnight oats are a lifesaver on busy mornings! Yollly can suggest more from what's in your fridge.",
        "Try savoury: eggs, spinach and feta on toast in five minutes. We built Yollly to spin up ideas like that.",
        "Smoothie bowls with frozen berries never get boring. Yollly turns a photo of your groceries into breakfast recipes.",
      ];
      const index = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % ideas.length;
      return { skip: false, skipReason: "", reply: ideas[index] };
    },
    moderation: () => ({ safe: true, issues: [] }),
  };

  async generateJson<S extends z.ZodType>(schema: S, schemaName: string, request: LlmRequest): Promise<z.infer<S>> {
    this.calls.push({ schemaName, request });
    const handler = this.handlers[schemaName];
    if (!handler) throw new Error(`no fake handler for ${schemaName}`);
    return schema.parse(handler(request));
  }
}

export class FakeApproval implements ApprovalChannel {
  readonly name = "fake";
  sent: Draft[] = [];
  closed: { draftId: string; status: string }[] = [];
  notices: string[] = [];
  private nextMessageId = 1;

  async start(_actions: ApprovalActions) {}
  async stop() {}
  async sendForApproval(product: Product, draft: Draft) {
    this.sent.push({ ...draft });
    return { chatId: product.approval.chatId, messageId: this.nextMessageId++ };
  }
  async closeCard(_product: Product, draft: Draft, status: string) {
    this.closed.push({ draftId: draft.id, status });
  }
  async notify(_product: Product, text: string) {
    this.notices.push(text);
  }
}

export async function makeContext(product = makeProduct()) {
  const store = new MemoryStore();
  const adapter = new FakeAdapter();
  const llm = new FakeLlm();
  const approval = new FakeApproval();
  const registry = new Registry(store, { fake: () => adapter }, { fake: llm }, { fake: approval });
  const ctx: AppContext = { store, registry, products: new Map([[product.id, product]]), log: silentLog };
  await store.setCredentials(product.id, {
    accessToken: "token",
    userId: "me-id",
    username: "yollly",
    source: "env",
    obtainedAt: new Date(),
  });
  return { ctx, store, adapter, llm, approval, product };
}
