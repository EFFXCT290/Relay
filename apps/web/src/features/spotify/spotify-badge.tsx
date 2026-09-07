"use client";

import { useEffect, useState } from "react";
import { Music2 } from "lucide-react";
import { spotifyApi } from "@/frontend-core/api-client/spotify";
import type { SpotifyBadge as SpotifyBadgeData } from "@relay/contracts";

const mono = "var(--font-mono)";
// Matches the server's cache TTL (see spotify.service.ts CACHE_TTL_S) — polling
// faster would just re-read the same cached value.
const POLL_MS = 45_000;

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

// A small "now playing / last played" badge for a user's profile. Renders
// nothing when there's no badge to show (not connected, hidden, or quiet for
// 24h+) — the caller doesn't need to know which of those it is.
//
// `compact` swaps the default two-line pill (art + track/artist stacked) for
// a single truncated text line — for spots like the thread header where it
// has to sit inline next to other text, not on its own row. Same data
// fetch/poll either way; only the rendering branches.
export function SpotifyBadge({ userId, compact }: { userId: string; compact?: boolean }) {
  const [badge, setBadge] = useState<SpotifyBadgeData | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await spotifyApi.getBadge(userId);
        if (!cancelled) setBadge(res.spotify);
      } catch {
        if (!cancelled) setBadge(null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [userId]);

  if (!loaded || !badge) return null;

  if (compact) {
    const compactContent = (
      <span
        className="flex min-w-0 items-center gap-1 truncate text-[10px] tracking-[0.04em]"
        style={{ fontFamily: mono, color: badge.isPlaying ? "#1ed760" : "var(--color-text-muted)" }}
      >
        <Music2 className="h-2.5 w-2.5 shrink-0" />
        <span className="truncate">{badge.trackName}</span>
      </span>
    );
    return badge.trackUrl ? (
      <a href={badge.trackUrl} target="_blank" rel="noreferrer" className="min-w-0 truncate">
        {compactContent}
      </a>
    ) : (
      compactContent
    );
  }

  const content = (
    <div
      className="flex items-center gap-2.5 rounded-full border py-1.5 pl-1.5 pr-3.5"
      style={{ borderColor: "var(--color-hairline)", background: "var(--color-panel)" }}
    >
      {badge.albumArtUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- external, unoptimized Spotify CDN art
        <img src={badge.albumArtUrl} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
      ) : (
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
          style={{ background: "rgba(30,215,96,0.14)" }}
        >
          <Music2 className="h-3.5 w-3.5" style={{ color: "#1ed760" }} />
        </div>
      )}
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[12.5px] font-semibold text-[var(--color-text)]">
          {badge.trackName}
        </span>
        <span className="truncate text-[11px] text-[var(--color-text-secondary)]">
          {badge.artistName}
        </span>
      </div>
      <span
        className="ml-1 shrink-0 text-[10px] font-medium uppercase tracking-[0.08em]"
        style={{ fontFamily: mono, color: badge.isPlaying ? "#1ed760" : "var(--color-text-muted)" }}
      >
        {badge.isPlaying ? (
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "#1ed760" }} />
            live
          </span>
        ) : (
          relativeTime(badge.playedAt!)
        )}
      </span>
    </div>
  );

  return badge.trackUrl ? (
    <a href={badge.trackUrl} target="_blank" rel="noreferrer" className="inline-block">
      {content}
    </a>
  ) : (
    content
  );
}
