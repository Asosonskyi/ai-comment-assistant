import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request, THREADS_GRAPH } from "./client";

export const THREADS_SCOPES = [
  "threads_basic",
  "threads_content_publish",
  "threads_keyword_search",
  "threads_read_replies",
  "threads_manage_replies",
];

const STATE_TTL_MS = 10 * 60 * 1000;

export interface ThreadsAppConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export interface TokenResult {
  accessToken: string;
  expiresAt?: Date;
}

export function buildAuthorizeUrl(app: ThreadsAppConfig, state: string): string {
  const url = new URL("https://threads.com/oauth/authorize");
  url.searchParams.set("client_id", app.appId);
  url.searchParams.set("redirect_uri", app.redirectUri);
  url.searchParams.set("scope", THREADS_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

// code -> short-lived token (1h) -> long-lived token (60 days).
export async function exchangeCodeForLongLivedToken(
  app: ThreadsAppConfig,
  code: string,
): Promise<TokenResult & { userId: string }> {
  const body = new URLSearchParams({
    client_id: app.appId,
    client_secret: app.appSecret,
    grant_type: "authorization_code",
    redirect_uri: app.redirectUri,
    code,
  });
  const short = await request<{ access_token: string; user_id: string | number }>(
    new URL(`${THREADS_GRAPH}/oauth/access_token`),
    { method: "POST", body },
  );

  const url = new URL(`${THREADS_GRAPH}/access_token`);
  url.searchParams.set("grant_type", "th_exchange_token");
  url.searchParams.set("client_secret", app.appSecret);
  url.searchParams.set("access_token", short.access_token);
  const long = await request<{ access_token: string; expires_in?: number }>(url, { method: "GET" });

  return { ...toTokenResult(long), userId: String(short.user_id) };
}

// Works only for long-lived tokens at least 24h old; returns a token valid 60 days from now.
export async function refreshLongLivedToken(accessToken: string): Promise<TokenResult> {
  const url = new URL(`${THREADS_GRAPH}/refresh_access_token`);
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", accessToken);
  return toTokenResult(await request<{ access_token: string; expires_in?: number }>(url, { method: "GET" }));
}

function toTokenResult(token: { access_token: string; expires_in?: number }): TokenResult {
  return {
    accessToken: token.access_token,
    expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : undefined,
  };
}

// OAuth `state`: productId.nonce.issuedAt.signature, HMAC-signed so the callback can trust the productId.
export function signState(productId: string, secret: string, now = Date.now()): string {
  const payload = `${productId}.${randomBytes(8).toString("hex")}.${now}`;
  return `${payload}.${hmac(payload, secret)}`;
}

export function verifyState(state: string, secret: string, now = Date.now()): string | null {
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  const [productId, nonce, issuedAt, signature] = parts as [string, string, string, string];
  const payload = `${productId}.${nonce}.${issuedAt}`;
  if (!safeEqual(signature, hmac(payload, secret))) return null;
  if (now - Number(issuedAt) > STATE_TTL_MS) return null;
  return productId;
}

// Meta's uninstall/delete callbacks send `signed_request` = base64url(sig).base64url(json payload).
export function parseSignedRequest(signedRequest: string, appSecret: string): { user_id?: string } | null {
  const [encodedSig, payload] = signedRequest.split(".");
  if (!encodedSig || !payload) return null;
  const expected = createHmac("sha256", appSecret).update(payload).digest("base64url");
  if (!safeEqual(encodedSig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { user_id?: string | number };
    return { user_id: data.user_id === undefined ? undefined : String(data.user_id) };
  } catch {
    return null;
  }
}

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
