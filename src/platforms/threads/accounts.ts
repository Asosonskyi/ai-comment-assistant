import type { Product } from "../../config/productSchema";
import { errorMessage, type AppContext } from "../../core/context";
import type { PublishQueue } from "../../core/publishQueue";
import { recoverReplyHistory } from "../../core/recovery";
import type { PlatformCredentials } from "../../core/types";
import { exchangeCodeForLongLivedToken, refreshLongLivedToken, type ThreadsAppConfig } from "./oauth";

const WARN_BEFORE_EXPIRY_MS = 7 * 24 * 3600_000;

// Connects Threads accounts (OAuth or env fallback token) and keeps their tokens fresh.
export class ThreadsAccounts {
  constructor(
    private readonly ctx: AppContext,
    private readonly queue: PublishQueue,
    readonly app: ThreadsAppConfig,
  ) {}

  // Boot: use the product's fallback env token, if any.
  async connectFromEnv(product: Product): Promise<boolean> {
    const token = product.platform.tokenEnv ? process.env[product.platform.tokenEnv] : undefined;
    if (!token) return false;
    try {
      await this.connect(product, { accessToken: token, source: "env" });
      // A refresh both extends the token and tells us its expiry (fails harmlessly if the token is < 24h old).
      await this.refresh(product.id);
      return true;
    } catch (err) {
      this.ctx.log.error({ product: product.id, err: errorMessage(err) }, "env token for Threads is not usable");
      return false;
    }
  }

  async completeOAuth(product: Product, code: string): Promise<PlatformCredentials> {
    const token = await exchangeCodeForLongLivedToken(this.app, code);
    const credentials = await this.connect(product, { ...token, source: "oauth" });
    await this.ctx.registry
      .approval(product)
      .notify(product, `🔗 ${product.name} connected to Threads as @${credentials.username} (token valid until ${credentials.expiresAt?.toISOString() ?? "unknown"}).`)
      .catch((err) => this.ctx.log.warn({ err: errorMessage(err) }, "could not send connect notice"));
    return credentials;
  }

  // Uninstall / data-deletion callbacks: drop the token (the only per-user data we hold besides the in-memory log).
  async disconnectByUserId(userId: string): Promise<string[]> {
    const disconnected: string[] = [];
    for (const [productId, credentials] of await this.ctx.store.listCredentials()) {
      if (credentials.userId !== userId) continue;
      await this.ctx.store.setCredentials(productId, null);
      disconnected.push(productId);
      this.ctx.log.warn({ product: productId }, "Threads account disconnected by Meta callback");
    }
    return disconnected;
  }

  // Daily: refresh every Threads token; warn approvers when one is close to expiring.
  async refreshAll() {
    for (const [productId, credentials] of await this.ctx.store.listCredentials()) {
      const product = this.ctx.products.get(productId);
      if (product?.platform.name !== "threads") continue;
      const ok = await this.refresh(productId);
      if (!ok && credentials.expiresAt && credentials.expiresAt.getTime() - Date.now() < WARN_BEFORE_EXPIRY_MS) {
        await this.ctx.registry
          .approval(product)
          .notify(product, `⚠️ ${product.name} Threads token expires ${credentials.expiresAt.toISOString()} and could not be refreshed. Log in again via /auth/threads/${productId}.`)
          .catch(() => undefined);
      }
    }
  }

  private async refresh(productId: string): Promise<boolean> {
    const credentials = await this.ctx.store.getCredentials(productId);
    if (!credentials) return false;
    try {
      const token = await refreshLongLivedToken(credentials.accessToken);
      await this.ctx.store.setCredentials(productId, {
        ...credentials,
        accessToken: token.accessToken,
        expiresAt: token.expiresAt ?? credentials.expiresAt,
      });
      return true;
    } catch (err) {
      this.ctx.log.warn({ product: productId, err: errorMessage(err) }, "Threads token refresh failed");
      return false;
    }
  }

  private async connect(
    product: Product,
    token: { accessToken: string; expiresAt?: Date; source: PlatformCredentials["source"] },
  ): Promise<PlatformCredentials> {
    // Store first so the adapter can use the token, then fill in who it belongs to.
    const provisional: PlatformCredentials = { ...token, userId: "", username: "", obtainedAt: new Date() };
    await this.ctx.store.setCredentials(product.id, provisional);
    try {
      const me = await this.ctx.registry.adapter(product).whoAmI();
      const credentials = { ...provisional, ...me };
      await this.ctx.store.setCredentials(product.id, credentials);
      await recoverReplyHistory(product, this.ctx, this.queue);
      this.ctx.log.info({ product: product.id, username: me.username, source: token.source }, "Threads account connected");
      return credentials;
    } catch (err) {
      await this.ctx.store.setCredentials(product.id, null);
      throw err;
    }
  }
}
