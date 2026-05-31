// Reads API/WS URLs from window.__ENV__ injected by /runtime-env.js at request
// time, so the same built bundle can be repointed by changing env vars and
// restarting the container — no rebuild needed.

declare global {
  interface Window {
    __ENV__?: { API_URL?: string; WS_URL?: string };
  }
}

export function getApiUrl(): string {
  if (typeof window !== "undefined" && window.__ENV__?.API_URL !== undefined) {
    return window.__ENV__.API_URL;
  }
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
}

export function getWsUrl(): string {
  if (typeof window !== "undefined" && window.__ENV__?.WS_URL !== undefined) {
    return window.__ENV__.WS_URL;
  }
  return process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3001";
}
