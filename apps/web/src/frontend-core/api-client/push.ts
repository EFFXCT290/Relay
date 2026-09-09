import { api } from "@/frontend-core/api";

export type PushPreferences = { pushMessages: boolean; pushCalls: boolean };

export const pushApi = {
  // The browser's PushSubscription.toJSON() shape; the server stores it raw.
  subscribe: (subscription: PushSubscriptionJSON) =>
    api<void>("/api/push/subscriptions", { method: "POST", body: subscription }),
  // A subscription has no client-facing id — endpoint (the browser's own URL
  // for it) is the only identifier there is, so it rides in the query string
  // rather than a path segment (a full URL, up to 2048 chars, doesn't belong
  // embedded in a path) or a DELETE body (unsupported by fetch's keepalive
  // mode and stripped by some proxies).
  unsubscribe: (endpoint: string) =>
    api<void>(`/api/push/subscriptions?endpoint=${encodeURIComponent(endpoint)}`, { method: "DELETE" }),
  getPreferences: () => api<PushPreferences>("/api/push/preferences"),
  setPreferences: (prefs: Partial<PushPreferences>) =>
    api<PushPreferences>("/api/push/preferences", { method: "PATCH", body: prefs }),
  test: () => api<void>("/api/push/test", { method: "POST" }),
};
