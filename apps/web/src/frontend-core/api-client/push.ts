import { api } from "@/frontend-core/api";

export type PushPreferences = { pushMessages: boolean; pushCalls: boolean };

export const pushApi = {
  // The browser's PushSubscription.toJSON() shape; the server stores it raw.
  subscribe: (subscription: PushSubscriptionJSON) =>
    api<void>("/api/push/subscribe", { method: "POST", body: subscription }),
  unsubscribe: (endpoint: string) =>
    api<void>("/api/push/subscribe", { method: "DELETE", body: { endpoint } }),
  getPreferences: () => api<PushPreferences>("/api/push/preferences"),
  setPreferences: (prefs: Partial<PushPreferences>) =>
    api<PushPreferences>("/api/push/preferences", { method: "PATCH", body: prefs }),
  test: () => api<void>("/api/push/test", { method: "POST" }),
};
