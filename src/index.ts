import Fastify from "fastify";
import { TelegramApproval } from "./approval/telegram";
import { loadEnv } from "./config/env";
import { loadProducts } from "./config/loadProducts";
import { DraftReview } from "./core/approvalActions";
import { errorMessage, type AppContext } from "./core/context";
import { Pipeline, RunLauncher } from "./core/pipeline";
import { PublishQueue } from "./core/publishQueue";
import { Registry } from "./core/registry";
import { AnthropicProvider } from "./llm/anthropic";
import { OpenAiProvider } from "./llm/openai";
import { ThreadsAccounts } from "./platforms/threads/accounts";
import { ThreadsAdapter } from "./platforms/threads/adapter";
import { registerServer } from "./server";
import { MemoryStore } from "./store/memoryStore";

const TOKEN_REFRESH_INTERVAL_MS = 24 * 3600_000;

async function main() {
  const env = loadEnv();
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      serializers: {
        // Keep the admin key and OAuth codes out of request logs.
        req: (req) => ({
          method: req.method,
          url: req.url.replace(/([?&](key|code|state)=)[^&]*/g, "$1***"),
          remoteAddress: req.ip,
        }),
      },
    },
  });

  const store = new MemoryStore();
  const telegram = new TelegramApproval(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_ALLOWED_USER_IDS, app.log);

  // Registry: add a new platform, LLM provider or approval channel here.
  const registry = new Registry(
    store,
    { threads: (getCredentials) => new ThreadsAdapter(getCredentials) },
    { anthropic: new AnthropicProvider(), openai: new OpenAiProvider() },
    { telegram },
  );

  const productList = await loadProducts(env.PRODUCTS_DIR, registry.names);
  const ctx: AppContext = {
    store,
    registry,
    products: new Map(productList.map((product) => [product.id, product])),
    log: app.log,
  };
  checkLlmKeys(ctx, env);
  if (env.TELEGRAM_ALLOWED_USER_IDS.length === 0) {
    app.log.warn("TELEGRAM_ALLOWED_USER_IDS is empty: nobody can approve drafts. Send /chatid to the bot to get your id.");
  }

  const queue = new PublishQueue(ctx);
  const pipeline = new Pipeline(ctx, queue);
  const threads = new ThreadsAccounts(ctx, queue, {
    appId: env.THREADS_APP_ID,
    appSecret: env.THREADS_APP_SECRET,
    redirectUri: `${env.PUBLIC_BASE_URL}/auth/threads/callback`,
  });

  await registerServer(app, { ctx, pipeline, queue, threads, publicBaseUrl: env.PUBLIC_BASE_URL, adminApiKey: env.ADMIN_API_KEY });
  await telegram.start(new DraftReview(ctx, queue), new RunLauncher(ctx, pipeline));

  for (const product of productList) {
    if (product.platform.name === "threads" && !(await threads.connectFromEnv(product))) {
      app.log.info(
        { product: product.id, login: `${env.PUBLIC_BASE_URL}/auth/threads/${product.id}?key=<ADMIN_API_KEY>` },
        "Threads account not connected; open the login URL",
      );
    }
  }

  const refreshTimer = setInterval(() => {
    threads.refreshAll().catch((err) => app.log.error({ err: errorMessage(err) }, "token refresh failed"));
  }, TOKEN_REFRESH_INTERVAL_MS);
  refreshTimer.unref();

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info({ products: productList.map((product) => product.id), publicBaseUrl: env.PUBLIC_BASE_URL }, "ready");

  const shutdown = async () => {
    clearInterval(refreshTimer);
    queue.stop();
    await telegram.stop().catch(() => undefined);
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

// Fail at boot rather than mid-run when a configured provider has no credentials.
function checkLlmKeys(ctx: AppContext, env: ReturnType<typeof loadEnv>) {
  const used = new Set(
    [...ctx.products.values()].flatMap((product) => Object.values(product.llm).flatMap((choice) => (choice ? [choice.provider] : []))),
  );
  if (used.has("openai") && !env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required by a product config");
  if (used.has("anthropic") && !env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    ctx.log.warn("ANTHROPIC_API_KEY not set; relying on ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile");
  }
}

main().catch((err) => {
  console.error(errorMessage(err));
  process.exit(1);
});
