import { getApiUrl } from "@/frontend-core/runtime-env";
import { api } from "@/frontend-core/api";
import type { SpotifyBadgeResponse, SpotifyConnectionStatus } from "@relay/contracts";

export const spotifyApi = {
  getBadge: (userId: string) => api<SpotifyBadgeResponse>(`/api/users/${userId}/spotify`),
  getStatus: () => api<SpotifyConnectionStatus>("/api/spotify/status"),
  setShowOnProfile: (showOnProfile: boolean) =>
    api<SpotifyConnectionStatus>("/api/spotify/preferences", { method: "PATCH", body: { showOnProfile } }),
  disconnect: () => api<void>("/api/spotify/disconnect", { method: "DELETE" }),
  // Not a fetch — a full-page navigation, so the OAuth redirect chain (and the
  // eventual bounce back to /profile) works the same as clicking a link.
  connectUrl: () => `${getApiUrl()}/api/spotify/connect`,
};
