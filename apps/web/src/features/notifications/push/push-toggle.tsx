"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, MessageSquare, Phone, Share, Loader2, Check } from "lucide-react";
import { Toggle } from "@/shared/components/toggle";
import { pushApi, type PushPreferences } from "@/frontend-core/api-client/push";
import { usePushSubscription } from "./use-push-subscription";

const mono = "var(--font-mono)";

// Settings block for Web Push: a master enable toggle, per-type preferences,
// a self-test button, and the iOS "install first" guidance Apple requires.
export function PushToggle() {
  const push = usePushSubscription();
  const [prefs, setPrefs] = useState<PushPreferences>({ pushMessages: true, pushCalls: true });
  const [testState, setTestState] = useState<"idle" | "sending" | "sent">("idle");

  useEffect(() => {
    if (!push.supported) return;
    void pushApi.getPreferences().then(setPrefs).catch(() => {});
  }, [push.supported]);

  const setPref = useCallback(
    async (key: keyof PushPreferences, value: boolean) => {
      const next = { ...prefs, [key]: value };
      setPrefs(next); // optimistic
      try {
        const saved = await pushApi.setPreferences({ [key]: value });
        setPrefs(saved);
      } catch {
        setPrefs(prefs); // revert
      }
    },
    [prefs],
  );

  const sendTest = useCallback(async () => {
    setTestState("sending");
    try {
      await pushApi.test();
      setTestState("sent");
      setTimeout(() => setTestState("idle"), 2500);
    } catch {
      setTestState("idle");
    }
  }, []);

  // iOS only delivers push from the Home-Screen-installed app, never a Safari tab.
  const needsInstall = push.isIOS && !push.isStandalone;

  return (
    <Card>
      <Row
        icon={<Bell className="h-3.5 w-3.5" style={{ color: "var(--color-signal)" }} />}
        tint="rgba(59,130,246,0.10)"
        tintBorder="rgba(59,130,246,0.22)"
        title="Push notifications"
        body={
          push.isSubscribed
            ? "On — you'll get notified on this device."
            : "Get notified about new messages and calls, even when Relay is closed."
        }
        control={
          needsInstall || !push.supported ? null : (
            <Toggle
              checked={push.isSubscribed}
              disabled={push.busy}
              ariaLabel="Push notifications"
              onChange={(v) => (v ? push.subscribe() : push.unsubscribe())}
            />
          )
        }
      />

      {/* iOS install instructions (Apple requires Add to Home Screen first). */}
      {needsInstall && (
        <>
          <Hairline />
          <div className="flex items-start gap-3.5 px-4 py-3.5">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border"
              style={{ background: "rgba(255,255,255,0.04)", borderColor: "var(--color-hairline)" }}
            >
              <Share className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />
            </div>
            <p className="text-[12px] leading-5 text-[var(--color-text-secondary)]">
              To enable notifications on iPhone or iPad, tap the{" "}
              <span className="text-[var(--color-text)]">Share</span> button in Safari, choose{" "}
              <span className="text-[var(--color-text)]">Add to Home Screen</span>, then open Relay
              from the new icon.
            </p>
          </div>
        </>
      )}

      {/* Not supported at all (and not an installable iOS tab). */}
      {!push.supported && !needsInstall && (
        <>
          <Hairline />
          <p className="px-4 py-3.5 text-[12px] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
            this browser doesn&apos;t support push notifications
          </p>
        </>
      )}

      {/* Per-type preferences + self-test — only meaningful once subscribed. */}
      {push.isSubscribed && (
        <>
          <Hairline />
          <Row
            icon={<MessageSquare className="h-3.5 w-3.5" style={{ color: "var(--color-text-secondary)" }} />}
            tint="rgba(255,255,255,0.04)"
            tintBorder="var(--color-hairline)"
            title="Messages"
            body="New direct messages."
            control={
              <Toggle
                checked={prefs.pushMessages}
                ariaLabel="Message notifications"
                onChange={(v) => setPref("pushMessages", v)}
              />
            }
          />
          <Hairline />
          <Row
            icon={<Phone className="h-3.5 w-3.5" style={{ color: "var(--color-text-secondary)" }} />}
            tint="rgba(255,255,255,0.04)"
            tintBorder="var(--color-hairline)"
            title="Calls"
            body="Incoming and missed calls."
            control={
              <Toggle
                checked={prefs.pushCalls}
                ariaLabel="Call notifications"
                onChange={(v) => setPref("pushCalls", v)}
              />
            }
          />
          <Hairline />
          <button
            type="button"
            onClick={sendTest}
            disabled={testState === "sending"}
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-[12px] tracking-[0.04em] text-[var(--color-signal)] hover:bg-white/[0.02] disabled:opacity-50"
            style={{ fontFamily: mono }}
          >
            {testState === "sending" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {testState === "sent" && <Check className="h-3.5 w-3.5" />}
            {testState === "sent" ? "test notification sent" : "send test notification"}
          </button>
        </>
      )}

      {push.error && (
        <>
          <Hairline />
          <p className="px-4 py-3 text-[11px] text-[var(--color-alert)]" style={{ fontFamily: mono }}>
            {push.error}
          </p>
        </>
      )}
    </Card>
  );
}

// ── Local presentation primitives (kept in sync with profile/page.tsx) ────────

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
