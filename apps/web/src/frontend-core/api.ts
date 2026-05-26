// Typed fetch wrapper around the Relay HTTP API.
// Sends HTTPOnly auth cookies via `credentials: "include"`.
// Throws ApiError (RFC 9457 shape) on non-2xx so callers can switch on status.

import { getApiUrl } from "./runtime-env";

export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
};

export class ApiError extends Error {
  status: number;
  problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail);
    this.status = problem.status;
    this.problem = problem;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
};

async function fetchOnce(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

function buildInit(opts: RequestOptions): RequestInit {
  return {
    method: opts.method ?? "GET",
    credentials: "include",
    // Only set Content-Type when there's actually a body to send. Fastify
    // rejects requests that advertise application/json with an empty body
    // (FST_ERR_CTP_EMPTY_JSON_BODY → 400 surfaced as 500), which silently
    // broke every body-less POST including /read, /accept, DELETE.
    ...(opts.body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body) }
      : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}

async function parseResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const problem: Problem = data ?? {
      type: "",
      title: "Error",
      status: res.status,
      detail: res.statusText,
    };
    throw new ApiError(problem);
  }

  return data as T;
}

// Single-flight: when several requests 401 at once (e.g. a burst after the
// access token lapses mid-session), they must share ONE refresh. Firing parallel
// POST /api/auth/refresh races rotating refresh tokens — the first rotates the
// cookie, the rest 401 on a now-stale token. Coalescing into one in-flight
// promise removes that race (and the console-noise burst).
let refreshInFlight: Promise<boolean> | null = null;

function silentRefresh(base: string): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${base}/api/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const base = getApiUrl();
  const url = `${base}${path}`;
  const init = buildInit(opts);

  const res = await fetchOnce(url, init);

  if (res.status === 401 && path !== "/api/auth/refresh") {
    const refreshed = await silentRefresh(base);
    if (refreshed) {
      const retryRes = await fetchOnce(url, init);
      return parseResponse<T>(retryRes);
    }
  }

  return parseResponse<T>(res);
}
