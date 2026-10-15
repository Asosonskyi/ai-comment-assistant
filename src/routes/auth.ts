import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { errorMessage, type AppContext } from "../core/context";
import type { ThreadsAccounts } from "../platforms/threads/accounts";
import { buildAuthorizeUrl, parseSignedRequest, signState, verifyState } from "../platforms/threads/oauth";

export interface AuthRouteDeps {
  ctx: AppContext;
  threads: ThreadsAccounts;
  publicBaseUrl: string;
}

// Threads OAuth (reached through the HTTPS tunnel) plus the callbacks Meta requires in app settings.
export async function authRoutes(app: FastifyInstance, { ctx, threads, publicBaseUrl }: AuthRouteDeps) {
  const secret = threads.app.appSecret;

  app.get<{ Params: { productId: string } }>("/auth/threads/:productId", async (request, reply) => {
    const product = ctx.products.get(request.params.productId);
    if (!product || product.platform.name !== "threads") {
      return reply.code(404).send({ error: "unknown Threads product" });
    }
    return reply.redirect(buildAuthorizeUrl(threads.app, signState(product.id, secret)));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    "/auth/threads/callback",
    { config: { public: true } },
    async (request, reply) => {
      const { code, state, error, error_description } = request.query;
      if (error) return reply.code(400).type("text/html").send(page("Login cancelled", error_description ?? error));
      const productId = state ? verifyState(state, secret) : null;
      const product = productId ? ctx.products.get(productId) : undefined;
      if (!code || !product) return reply.code(400).type("text/html").send(page("Login failed", "Invalid or expired state. Start again."));

      try {
        const credentials = await threads.completeOAuth(product, code.replace(/#_$/, ""));
        return reply
          .type("text/html")
          .send(page("Connected", `${product.name} is connected to Threads as @${credentials.username}. You can close this tab.`));
      } catch (err) {
        request.log.error({ err: errorMessage(err) }, "Threads OAuth failed");
        return reply.code(502).type("text/html").send(page("Login failed", errorMessage(err)));
      }
    },
  );

  app.post<{ Body: { signed_request?: string } }>(
    "/auth/threads/uninstall",
    { config: { public: true } },
    async (request, reply) => {
      const data = parseSignedRequest(request.body?.signed_request ?? "", secret);
      if (!data?.user_id) return reply.code(400).send({ error: "invalid signed_request" });
      await threads.disconnectByUserId(data.user_id);
      return { success: true };
    },
  );

  app.post<{ Body: { signed_request?: string } }>(
    "/auth/threads/delete",
    { config: { public: true } },
    async (request, reply) => {
      const data = parseSignedRequest(request.body?.signed_request ?? "", secret);
      if (!data?.user_id) return reply.code(400).send({ error: "invalid signed_request" });
      await threads.disconnectByUserId(data.user_id);
      const confirmationCode = randomBytes(8).toString("hex");
      return {
        url: `${publicBaseUrl}/auth/threads/deletion-status?code=${confirmationCode}`,
        confirmation_code: confirmationCode,
      };
    },
  );

  app.get("/auth/threads/deletion-status", { config: { public: true } }, async (_request, reply) =>
    reply.type("text/html").send(page("Data deleted", "Access tokens for this account were deleted. No other personal data is stored.")),
  );
}

function page(title: string, message: string): string {
  const escape = (value: string) => value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${escape(title)}</h1><p>${escape(message)}</p></body>`;
}
