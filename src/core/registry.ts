import type { ApprovalChannel } from "../approval/ApprovalChannel";
import { llmChoiceFor, type LlmChoice, type LlmStage, type Product } from "../config/productSchema";
import type { LlmProvider } from "../llm/LlmProvider";
import type { PlatformAdapter } from "../platforms/PlatformAdapter";
import type { Store } from "../store/Store";
import type { PlatformCredentials } from "./types";

export type PlatformFactory = (getCredentials: () => Promise<PlatformCredentials | undefined>) => PlatformAdapter;

// Maps config names ("threads", "anthropic", "telegram") to implementations.
export class Registry {
  private adapters = new Map<string, PlatformAdapter>();

  constructor(
    private readonly store: Store,
    private readonly platforms: Record<string, PlatformFactory>,
    private readonly llms: Record<string, LlmProvider>,
    private readonly approvals: Record<string, ApprovalChannel>,
  ) {}

  get names() {
    return {
      platforms: Object.keys(this.platforms),
      llmProviders: Object.keys(this.llms),
      approvalChannels: Object.keys(this.approvals),
    };
  }

  adapter(product: Product): PlatformAdapter {
    let adapter = this.adapters.get(product.id);
    if (!adapter) {
      const factory = this.platforms[product.platform.name];
      if (!factory) throw new Error(`No platform adapter registered for "${product.platform.name}"`);
      adapter = factory(() => this.store.getCredentials(product.id));
      this.adapters.set(product.id, adapter);
    }
    return adapter;
  }

  llm(product: Product, stage: LlmStage): { provider: LlmProvider; choice: LlmChoice } {
    const choice = llmChoiceFor(product, stage);
    const provider = this.llms[choice.provider];
    if (!provider) throw new Error(`No LLM provider registered for "${choice.provider}"`);
    return { provider, choice };
  }

  approval(product: Product): ApprovalChannel {
    const channel = this.approvals[product.approval.channel];
    if (!channel) throw new Error(`No approval channel registered for "${product.approval.channel}"`);
    return channel;
  }

  allApprovalChannels(): ApprovalChannel[] {
    return Object.values(this.approvals);
  }
}
