"use client";

import { useCallback, useEffect, useState } from "react";
import { spotifyApi } from "@/frontend-core/api-client/spotify";
import type { SpotifyConnectionStatus } from "@relay/contracts";

export type SpotifyConnectResult = "connected" | "error" | null;

export type SpotifyConnectionState = {
  status: SpotifyConnectionStatus | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  connectUrl: string;
  disconnect: () => Promise<void>;
  setShowOnProfile: (value: boolean) => Promise<void>;
  refresh: () => Promise<void>;
};

// Reads the `?spotify=connected|error&reason=...` query the OAuth callback
// redirects back to /profile with — a one-time landing state, cleared from the
// URL immediately so a refresh of the page doesn't replay the toast.
export function readSpotifyRedirectResult(): { result: SpotifyConnectResult; reason: string | null } {
  if (typeof window === "undefined") return { result: null, reason: null };
  const params = new URLSearchParams(window.location.search);
  const result = params.get("spotify");
  if (result !== "connected" && result !== "error") return { result: null, reason: null };
  const reason = params.get("reason");

  params.delete("spotify");
  params.delete("reason");
  const query = params.toString();
  const nextUrl = window.location.pathname + (query ? `?${query}` : "");
  window.history.replaceState(null, "", nextUrl);

  return { result, reason };
}

export function useSpotifyConnection(): SpotifyConnectionState {
  const [status, setStatus] = useState<SpotifyConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await spotifyApi.getStatus());
      setError(null);
    } catch {
      setError("Couldn't load Spotify connection status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await spotifyApi.disconnect();
      await refresh();
    } catch {
      setError("Couldn't disconnect Spotify. Try again.");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const setShowOnProfile = useCallback(
    async (value: boolean) => {
      if (!status) return;
      const prev = status;
      setStatus({ ...status, showOnProfile: value }); // optimistic
      try {
        setStatus(await spotifyApi.setShowOnProfile(value));
      } catch {
        setStatus(prev); // revert
        setError("Couldn't update that setting. Try again.");
      }
    },
    [status],
  );

  return {
    status,
    loading,
    busy,
    error,
    connectUrl: spotifyApi.connectUrl(),
    disconnect,
    setShowOnProfile,
    refresh,
  };
}
