import type { Product } from "../config/productSchema";
import type { Draft } from "../core/types";

// What a human can do with a draft. Each returns a short status line for the channel to show.
export interface ApprovalActions {
  approve(draftId: string): Promise<string>;
  reject(draftId: string): Promise<string>;
  edit(draftId: string, text: string): Promise<string>;
  redraft(draftId: string, feedback: string): Promise<string>;
}

// What a human can trigger from the channel besides reviewing drafts.
export interface RunControl {
  products(): { id: string; name: string }[];
  // Starts a pipeline run; resolves to a short status line for the channel to show.
  startRun(productId: string): Promise<string>;
}

// The only place that talks to the approvers (Telegram for the POC; Slack or a web queue later).
export interface ApprovalChannel {
  readonly name: string;
  start(actions: ApprovalActions, control: RunControl): Promise<void>;
  stop(): Promise<void>;
  sendForApproval(product: Product, draft: Draft): Promise<{ chatId: number | string; messageId: number }>;
  // Replaces the draft card's buttons with a final status line.
  closeCard(product: Product, draft: Draft, status: string): Promise<void>;
  notify(product: Product, text: string): Promise<void>;
}
