import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { Pipeline } from "../src/core/pipeline";
import { PublishQueue } from "../src/core/publishQueue";
import { ThreadsAccounts } from "../src/platforms/threads/accounts";
import { registerServer } from "../src/server";
import { makeContext, makeProduct } from "./fixtures";

const KEY = "test-admin-key-123456";

async function buildApp() {
  const env = await makeContext(makeProduct({ platform: { name: "fake" } }));
  const queue = new PublishQueue(env.ctx);
  const app = Fastify();
  await registerServer(app, {
    ctx: env.ctx,
    pipeline: new Pipeline(env.ctx, queue),
    queue,
    threads: new ThreadsAccounts(env.ctx, queue, { appId: "1", appSecret: "secret", redirectUri: "https://x.test/cb" }),
    publicBaseUrl: "https://x.test",
    adminApiKey: KEY,
  });
  return { app, ...env };
}

describe("HTTP API", () => {
  it("requires the admin key except on public OAuth callbacks", async () => {
    const { app } = await buildApp();
    expect((await app.inject({ url: "/health" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/health", headers: { "x-api-key": "wrong" } })).statusCode).toBe(401);

    const health = await app.inject({ url: "/health", headers: { "x-api-key": KEY } });
    expect(health.statusCode).toBe(200);
    expect(health.json().products[0]).toMatchObject({ id: "yollly", connected: true, username: "yollly", paused: null });

    const callback = await app.inject({ url: "/auth/threads/callback?code=abc&state=forged" });
    expect(callback.statusCode).toBe(400);
    expect(callback.body).toContain("Invalid or expired state");
  });

  it("starts a run, reports it, and handles pause/resume", async () => {
    const { app } = await buildApp();
    const headers = { "x-api-key": KEY };

    const started = await app.inject({ method: "POST", url: "/products/yollly/run", headers });
    expect(started.statusCode).toBe(202);
    const run = await app.inject({ url: `/runs/${started.json().runId}`, headers });
    expect(run.statusCode).toBe(200);
    expect(run.json().productId).toBe("yollly");

    expect((await app.inject({ method: "POST", url: "/products/nope/run", headers })).statusCode).toBe(404);

    await app.inject({ method: "POST", url: "/products/yollly/pause", headers, payload: { reason: "testing" } });
    // Wait for the first run to finish so the 409 comes from the pause, not the active run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const blocked = await app.inject({ method: "POST", url: "/products/yollly/run", headers });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain("paused: testing");

    const resumed = await app.inject({ method: "POST", url: "/products/yollly/resume", headers });
    expect(resumed.json()).toEqual({ paused: false, queued: 0 });
  });

  it("parses Meta's form-encoded uninstall callback and verifies the signature", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/auth/threads/uninstall",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "signed_request=bad.sig",
    });
    expect(response.statusCode).toBe(400);
  });

  it("redirects the OAuth start link to Threads with a signed state", async () => {
    const { app, ctx } = await buildApp();
    ctx.products.set("thr", makeProduct({ id: "thr", platform: { name: "threads" } }));
    const response = await app.inject({ url: `/auth/threads/thr?key=${KEY}` });
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.host).toBe("threads.com");
    expect(location.searchParams.get("state")).toMatch(/^thr\./);
  });
});
