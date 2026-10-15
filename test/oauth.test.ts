import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAuthorizeUrl, parseSignedRequest, signState, verifyState } from "../src/platforms/threads/oauth";
import { toNeutralPost } from "../src/platforms/threads/adapter";

describe("Threads OAuth helpers", () => {
  it("signs and verifies state, rejecting tampering and expiry", () => {
    const state = signState("yollly", "secret", 1_000);
    expect(verifyState(state, "secret", 2_000)).toBe("yollly");
    expect(verifyState(state.replace("yollly", "other"), "secret", 2_000)).toBeNull();
    expect(verifyState(state, "wrong", 2_000)).toBeNull();
    expect(verifyState(state, "secret", 1_000 + 11 * 60_000)).toBeNull();
  });

  it("builds the authorize URL with all scopes", () => {
    const url = new URL(buildAuthorizeUrl({ appId: "1", appSecret: "s", redirectUri: "https://x.test/cb" }, "st"));
    expect(url.searchParams.get("scope")).toContain("threads_keyword_search");
    expect(url.searchParams.get("redirect_uri")).toBe("https://x.test/cb");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("parses a valid signed_request and rejects a forged one", () => {
    const payload = Buffer.from(JSON.stringify({ user_id: 42, algorithm: "HMAC-SHA256" })).toString("base64url");
    const signature = createHmac("sha256", "app-secret").update(payload).digest("base64url");
    expect(parseSignedRequest(`${signature}.${payload}`, "app-secret")).toEqual({ user_id: "42" });
    expect(parseSignedRequest(`${signature}.${payload}`, "other-secret")).toBeNull();
    expect(parseSignedRequest("garbage", "app-secret")).toBeNull();
  });
});

describe("Threads media mapping", () => {
  it("maps replies to their root post and parses Threads timestamps", () => {
    const post = toNeutralPost({
      id: "2",
      text: "hi",
      username: "anna",
      timestamp: "2026-10-14T08:30:00+0000",
      is_reply: true,
      root_post: { id: "1" },
    });
    expect(post.rootId).toBe("1");
    expect(post.createdAt.toISOString()).toBe("2026-10-14T08:30:00.000Z");
    expect(toNeutralPost({ id: "3", is_reply: false }).rootId).toBe("3");
  });
});
