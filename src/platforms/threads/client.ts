import { PlatformError, type PlatformErrorKind } from "../PlatformAdapter";

export const THREADS_GRAPH = "https://graph.threads.net";
const API_VERSION = "v1.0";

type Params = Record<string, string | number | boolean | undefined | null>;

// Thin fetch wrapper for graph.threads.net. Never includes the token in thrown errors.
export class ThreadsClient {
  constructor(private readonly getToken: () => Promise<string>) {}

  async get<T>(path: string, params: Params = {}): Promise<T> {
    const url = new URL(`${THREADS_GRAPH}/${API_VERSION}/${path.replace(/^\//, "")}`);
    appendParams(url.searchParams, { ...params, access_token: await this.getToken() });
    return request<T>(url, { method: "GET" });
  }

  async post<T>(path: string, params: Params = {}): Promise<T> {
    const url = new URL(`${THREADS_GRAPH}/${API_VERSION}/${path.replace(/^\//, "")}`);
    const body = new URLSearchParams();
    appendParams(body, { ...params, access_token: await this.getToken() });
    return request<T>(url, { method: "POST", body });
  }

  // Follows `paging.next` links (which already carry the token) up to maxPages.
  async getAll<T>(path: string, params: Params, maxPages: number): Promise<T[]> {
    const items: T[] = [];
    let page = await this.get<Paged<T>>(path, params);
    for (let i = 0; ; i++) {
      items.push(...(page.data ?? []));
      if (!page.paging?.next || i + 1 >= maxPages) break;
      page = await request<Paged<T>>(new URL(page.paging.next), { method: "GET" });
    }
    return items;
  }
}

interface Paged<T> {
  data?: T[];
  paging?: { next?: string };
}

function appendParams(target: URLSearchParams, params: Params) {
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) target.set(key, String(value));
  }
}

export async function request<T>(url: URL, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new PlatformError("threads", "other", `network error on ${url.pathname}: ${(err as Error).message}`);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || body.error || body.error_message) {
    throw toPlatformError(response.status, body, url.pathname);
  }
  return body as T;
}

interface GraphError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
}

function toPlatformError(status: number, body: Record<string, unknown>, path: string): PlatformError {
  // Graph endpoints return { error: {...} }; OAuth endpoints return { error_type, code, error_message }.
  const graph = (body.error ?? {}) as GraphError;
  const code = graph.code ?? (typeof body.code === "number" ? body.code : undefined);
  const message = graph.message ?? (body.error_message as string | undefined) ?? `HTTP ${status}`;
  return new PlatformError("threads", classify(status, code), `${message} (${path}, code ${code ?? "n/a"})`, code);
}

function classify(status: number, code: number | undefined): PlatformErrorKind {
  if (status === 429 || (code !== undefined && [4, 17, 32, 613].includes(code))) return "rate_limited";
  if (code === 368) return "restricted"; // action deemed abusive / temporarily blocked
  if (code === 190) return "auth";
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) return "permission";
  return "other";
}
