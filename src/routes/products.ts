import type { FastifyInstance } from "fastify";
import type { AppContext } from "../core/context";
import { RunRejectedError, type Pipeline } from "../core/pipeline";
import type { PublishQueue } from "../core/publishQueue";

export interface ProductRouteDeps {
  ctx: AppContext;
  pipeline: Pipeline;
  queue: PublishQueue;
}

type ProductParams = { Params: { id: string } };

export async function productRoutes(app: FastifyInstance, { ctx, pipeline, queue }: ProductRouteDeps) {
  const { store, products } = ctx;

  app.get("/health", async () => ({
    ok: true,
    products: await Promise.all(
      [...products.values()].map(async (product) => {
        const credentials = await store.getCredentials(product.id);
        return {
          id: product.id,
          platform: product.platform.name,
          connected: Boolean(credentials),
          username: credentials?.username,
          tokenSource: credentials?.source,
          tokenExpiresAt: credentials?.expiresAt,
          paused: await store.getPausedReason(product.id),
          queued: queue.size(product.id),
        };
      }),
    ),
  }));

  app.get("/products", async () => [...products.values()]);

  app.post<ProductParams>("/products/:id/run", async (request, reply) => {
    const product = products.get(request.params.id);
    if (!product) return reply.code(404).send({ error: "unknown product" });
    try {
      const run = await pipeline.startRun(product);
      return reply.code(202).send({ runId: run.id, status: `/runs/${run.id}` });
    } catch (err) {
      if (err instanceof RunRejectedError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Params: { runId: string } }>("/runs/:runId", async (request, reply) => {
    const run = await store.getRun(request.params.runId);
    if (!run) return reply.code(404).send({ error: "unknown run (runs are kept in memory until restart)" });
    return run;
  });

  app.get<ProductParams>("/products/:id/replies", async (request, reply) => {
    if (!products.has(request.params.id)) return reply.code(404).send({ error: "unknown product" });
    return store.listReplies(request.params.id);
  });

  app.post<ProductParams & { Body: { reason?: string } | undefined }>("/products/:id/pause", async (request, reply) => {
    if (!products.has(request.params.id)) return reply.code(404).send({ error: "unknown product" });
    await store.setPaused(request.params.id, request.body?.reason ?? "paused manually");
    return { paused: true };
  });

  app.post<ProductParams>("/products/:id/resume", async (request, reply) => {
    if (!products.has(request.params.id)) return reply.code(404).send({ error: "unknown product" });
    await store.setPaused(request.params.id, null);
    queue.kick(request.params.id);
    return { paused: false, queued: queue.size(request.params.id) };
  });
}
