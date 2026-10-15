import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authRoutes, type AuthRouteDeps } from "./routes/auth";
import { productRoutes, type ProductRouteDeps } from "./routes/products";

declare module "fastify" {
  interface FastifyContextConfig {
    // Routes Meta or the browser call without the admin key.
    public?: boolean;
  }
}

export interface ServerDeps extends ProductRouteDeps, AuthRouteDeps {
  adminApiKey: string;
}

export async function registerServer(app: FastifyInstance, deps: ServerDeps) {
  // Meta's uninstall/delete callbacks post application/x-www-form-urlencoded.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // Admin key from the `x-api-key` header, or `?key=` for links opened in a browser (OAuth start).
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.config?.public) return;
    const header = request.headers["x-api-key"];
    const query = (request.query as Record<string, unknown> | undefined)?.key;
    const provided = typeof header === "string" ? header : typeof query === "string" ? query : "";
    if (!safeEqual(provided, deps.adminApiKey)) return reply.code(401).send({ error: "missing or invalid API key" });
  });

  await productRoutes(app, deps);
  await authRoutes(app, deps);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
