import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Product } from "../config/productSchema";
import { errorMessage, type Logger } from "../core/context";
import type { Draft } from "../core/types";
import type { ApprovalActions, ApprovalChannel, RunControl } from "./ApprovalChannel";

const POST_PREVIEW_CHARS = 1500;

type PendingKind = "edit" | "redraft";

// Telegram approval channel (grammY, long polling: no public URL needed).
// Buttons: Approve / Edit / Redraft / Reject. Edit and Redraft ask for a text reply.
export class TelegramApproval implements ApprovalChannel {
  readonly name = "telegram";
  private readonly bot: Bot;
  private readonly allowed: Set<number>;
  private actions?: ApprovalActions;
  private control?: RunControl;
  // `${chatId}:${userId}` -> what the next text message from that user means.
  private pending = new Map<string, { draftId: string; kind: PendingKind }>();

  constructor(token: string, allowedUserIds: number[], private readonly log: Logger) {
    this.bot = new Bot(token);
    this.allowed = new Set(allowedUserIds);
    this.registerHandlers();
  }

  async start(actions: ApprovalActions, control: RunControl) {
    this.actions = actions;
    this.control = control;
    await this.bot.init();
    void this.bot.start({
      drop_pending_updates: true,
      onStart: (info) => this.log.info({ bot: info.username }, "telegram bot polling"),
    });
  }

  async stop() {
    await this.bot.stop();
  }

  async sendForApproval(product: Product, draft: Draft) {
    const message = await this.bot.api.sendMessage(product.approval.chatId, renderCard(product, draft), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .text("✅ Approve", `a:${draft.id}`)
        .text("✏️ Edit", `e:${draft.id}`)
        .row()
        .text("🔁 Redraft", `r:${draft.id}`)
        .text("🚫 Reject", `x:${draft.id}`),
    });
    return { chatId: product.approval.chatId, messageId: message.message_id };
  }

  async closeCard(product: Product, draft: Draft, status: string) {
    if (!draft.approvalRef) return;
    try {
      // Editing without reply_markup removes the buttons.
      await this.bot.api.editMessageText(
        draft.approvalRef.chatId,
        draft.approvalRef.messageId,
        `${renderCard(product, draft)}\n\n<b>${escapeHtml(status)}</b>`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );
    } catch (err) {
      this.log.warn({ draftId: draft.id, err: errorMessage(err) }, "could not update telegram card");
    }
  }

  async notify(product: Product, text: string) {
    await this.bot.api.sendMessage(product.approval.chatId, text, { link_preview_options: { is_disabled: true } });
  }

  private registerHandlers() {
    // Anyone may ask for ids; needed to fill TELEGRAM_ALLOWED_USER_IDS and approval.chatId.
    this.bot.command("chatid", (ctx) => ctx.reply(`chat id: ${ctx.chat.id}\nyour user id: ${ctx.from?.id}`));

    this.bot.use(async (ctx, next) => {
      if (ctx.from && this.allowed.has(ctx.from.id)) return next();
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "You are not an approver.", show_alert: true });
    });

    // /run [productId]: starts a pipeline run (the product id may be omitted when only one is configured).
    this.bot.command("run", async (ctx) => {
      const control = this.control;
      if (!control) return;
      const products = control.products();
      const arg = ctx.match.trim();
      const product = arg ? products.find((item) => item.id === arg) : products.length === 1 ? products[0] : undefined;
      if (!product) {
        await ctx.reply(`Usage: /run <product>\nProducts: ${products.map((item) => item.id).join(", ") || "none"}`);
        return;
      }
      await ctx.reply(await control.startRun(product.id));
    });

    this.bot.command("cancel", async (ctx) => {
      this.pending.delete(pendingKey(ctx));
      await ctx.reply("Cancelled.");
    });

    this.bot.callbackQuery(/^([aerx]):(.+)$/, async (ctx) => {
      const [, action, draftId] = ctx.match as RegExpMatchArray as [string, string, string];
      const actions = this.requireActions();

      if (action === "a" || action === "x") {
        const result = action === "a" ? await actions.approve(draftId) : await actions.reject(draftId);
        await ctx.answerCallbackQuery({ text: result.slice(0, 190) });
        return;
      }

      const kind: PendingKind = action === "e" ? "edit" : "redraft";
      this.pending.set(pendingKey(ctx), { draftId, kind });
      await ctx.answerCallbackQuery();
      await ctx.reply(
        kind === "edit"
          ? `Send the full replacement text for draft ${draftId} (or /cancel).`
          : `What should change in draft ${draftId}? Send your feedback (or /cancel).`,
        {
          reply_markup: { force_reply: true, selective: true },
          reply_parameters: ctx.callbackQuery.message ? { message_id: ctx.callbackQuery.message.message_id } : undefined,
        },
      );
    });

    this.bot.on("message:text", async (ctx) => {
      const key = pendingKey(ctx);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      const actions = this.requireActions();
      if (pending.kind === "redraft") await ctx.reply("Redrafting…");
      const result =
        pending.kind === "edit"
          ? await actions.edit(pending.draftId, ctx.message.text)
          : await actions.redraft(pending.draftId, ctx.message.text);
      await ctx.reply(result);
    });

    this.bot.catch((err) => this.log.error({ err: errorMessage(err.error) }, "telegram handler error"));
  }

  private requireActions(): ApprovalActions {
    if (!this.actions) throw new Error("approval channel not started");
    return this.actions;
  }
}

function pendingKey(ctx: Context): string {
  return `${ctx.chat?.id}:${ctx.from?.id}`;
}

export function renderCard(product: Product, draft: Draft): string {
  const { post, relevance, reason } = draft.candidate;
  const author = post.url ? `<a href="${escapeHtml(post.url)}">@${escapeHtml(post.authorHandle)}</a>` : `@${escapeHtml(post.authorHandle)}`;
  const postText = post.text.length > POST_PREVIEW_CHARS ? `${post.text.slice(0, POST_PREVIEW_CHARS)}…` : post.text;
  return [
    `<b>${escapeHtml(product.name)}</b> · ${escapeHtml(post.platform)} · draft <code>${draft.id}</code>`,
    `Relevance ${relevance.toFixed(2)}: ${escapeHtml(reason)}`,
    "",
    `${author} wrote:`,
    `<blockquote>${escapeHtml(postText)}</blockquote>`,
    `<b>Draft reply</b> (${[...draft.text].length} chars):`,
    `<blockquote>${escapeHtml(draft.text)}</blockquote>`,
    ...(draft.feedback.length ? [`<i>Feedback applied: ${escapeHtml(draft.feedback.join(" / "))}</i>`] : []),
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
