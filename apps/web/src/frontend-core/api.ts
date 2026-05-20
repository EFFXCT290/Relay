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

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = `${getApiUrl()}${path}`;
  // Only set Content-Type when there's actually a body to send. Fastify
  // rejects requests that advertise application/json with an empty body
  // (FST_ERR_CTP_EMPTY_JSON_BODY → 400 surfaced as 500), which silently
  // broke every body-less POST including /read, /accept, DELETE.
  const init: RequestInit = {
    method: opts.method ?? "GET",
    credentials: "include",
    ...(opts.body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body) }
      : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  const res = await fetch(url, init);

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
