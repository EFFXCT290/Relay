"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Music2 } from "lucide-react";
import { Toggle } from "@/shared/components/toggle";
import { Skeleton, SkeletonLine } from "@/shared/ui/skeleton";
import {
  readSpotifyRedirectResult,
  useSpotifyConnection,
} from "./use-spotify-connection";

const mono = "var(--font-mono)";

// Settings block for the Spotify badge: connect/disconnect + the showOnProfile
// toggle, plus the one-time banner the OAuth redirect lands with.
export function SpotifyConnectCard() {
  const conn = useSpotifyConnection();
  const [redirectNotice, setRedirectNotice] = useState<{ kind: "connected" | "error"; reason: string | null } | null>(null);

  useEffect(() => {
    const { result, reason } = readSpotifyRedirectResult();
    if (result) setRedirectNotice({ kind: result, reason });
  }, []);

  if (conn.loading) {
    return (
      <Card>
        <div className="flex items-center gap-3.5 px-4 py-3.5">
          <Skeleton className="h-8 w-8 shrink-0 rounded-[10px]" />
          <div className="flex flex-1 flex-col gap-1.5">
            <SkeletonLine className="h-3.5 w-20" />
            <SkeletonLine className="h-3 w-40" />
          </div>
        </div>
      </Card>
    );
  }

  const connected = conn.status?.connected ?? false;

  return (
    <>
      {redirectNotice && (
        <p
          className="px-1 pb-2 text-[12px]"
          style={{ color: redirectNotice.kind === "connected" ? "var(--color-online)" : "var(--color-alert)" }}
        >
          {redirectNotice.kind === "connected"
            ? "Spotify connected."
            : `Couldn't connect Spotify (${redirectNotice.reason ?? "unknown error"}).`}
        </p>
      )}

      <Card>
        <Row
          icon={<Music2 className="h-3.5 w-3.5" style={{ color: "#1ed760" }} />}
          tint="rgba(30,215,96,0.10)"
          tintBorder="rgba(30,215,96,0.22)"
          title="Spotify"
          body={
            connected
              ? "Shows what you're currently or recently playing on your profile."
              : "Connect Spotify to show a live badge of what you're playing."
          }
          control={
            connected ? (
              <button
                type="button"
                onClick={conn.disconnect}
                disabled={conn.busy}
                className="text-[11px] tracking-[0.04em] text-[var(--color-alert)] disabled:opacity-50"
                style={{ fontFamily: mono }}
              >
                {conn.busy ? "disconnecting…" : "disconnect"}
              </button>
            ) : (
              <a
                href={conn.connectUrl}
                className="rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.04em] text-black"
                style={{ fontFamily: mono, background: "#1ed760" }}
              >
                connect
              </a>
            )
          }
        />

        {connected && conn.status?.needsReconnect && (
          <>
            <Hairline />
            <div className="flex items-start gap-3.5 px-4 py-3.5">
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border"
                style={{ background: "rgba(239,68,68,0.10)", borderColor: "rgba(239,68,68,0.22)" }}
              >
                <AlertTriangle className="h-3.5 w-3.5" style={{ color: "var(--color-alert)" }} />
              </div>
              <div className="flex flex-1 flex-col gap-1">
                <p className="text-[12.5px] font-semibold text-[var(--color-text)]">Needs reconnecting</p>
                <p className="text-[12px] leading-4 text-[var(--color-text-secondary)]">
                  Spotify stopped accepting our access — this usually means it was revoked from Spotify&apos;s
                  side. Reconnect to bring the badge back.
                </p>
                <a
                  href={conn.connectUrl}
                  className="mt-1 self-start text-[11px] tracking-[0.04em] text-[var(--color-signal)]"
                  style={{ fontFamily: mono }}
                >
                  reconnect
                </a>
              </div>
            </div>
          </>
        )}

        {connected && (
          <>
            <Hairline />
            <Row
              icon={<Music2 className="h-3.5 w-3.5" style={{ color: "var(--color-text-secondary)" }} />}
              tint="rgba(255,255,255,0.04)"
              tintBorder="var(--color-hairline)"
              title="Show on profile"
              body="Let other people see your badge. On by default once connected."
              control={
                <Toggle
                  checked={conn.status?.showOnProfile ?? true}
                  ariaLabel="Show Spotify on profile"
                  onChange={conn.setShowOnProfile}
                />
              }
            />
          </>
        )}

        {connected && (
          <>
            <Hairline />
            <p className="px-4 py-3 text-[11px] leading-4 text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
              disconnecting only removes relay&apos;s copy of your tokens — to fully revoke access, remove relay
              from spotify&apos;s own app settings too
            </p>
          </>
        )}

        {conn.error && (
          <>
            <Hairline />
            <p className="px-4 py-3 text-[11px] text-[var(--color-alert)]" style={{ fontFamily: mono }}>
              {conn.error}
            </p>
          </>
        )}
      </Card>
    </>
  );
}

// ── Local presentation primitives (kept in sync with profile/page.tsx) ──────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col overflow-hidden rounded-[18px] border bg-[var(--color-panel)]"
      style={{ borderColor: "var(--color-hairline)" }}
    >
      {children}
    </div>
  );
}

function Hairline() {
  return <div className="mx-4 h-px" style={{ background: "var(--color-hairline)" }} />;
}

function Row({
  icon,
  tint,
  tintBorder,
  title,
  body,
  control,
}: {
  icon: React.ReactNode;
  tint: string;
  tintBorder: string;
  title: string;
  body: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5 px-4 py-3.5">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border"
        style={{ background: tint, borderColor: tintBorder }}
      >
        {icon}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-[14px] font-semibold text-[var(--color-text)]">{title}</p>
        <p className="text-[12px] leading-4 text-[var(--color-text-secondary)]">{body}</p>
      </div>
      {control}
    </div>
  );
}
