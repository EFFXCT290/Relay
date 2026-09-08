"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, Trash2, X } from "lucide-react";
import { Avatar } from "@/shared/components/avatar";
import { Toggle } from "@/shared/components/toggle";
import { SpotifyBadge } from "@/features/spotify/spotify-badge";
import { nicknamesApi } from "@/frontend-core/api-client/nicknames";
import { formatLastSeen } from "@/frontend-core/format-presence";

const mono = "var(--font-mono)";
const display = "var(--font-display)";
const MAX_NICKNAME_LENGTH = 60;

type Participant = {
  userId: string;
  username: string;
  avatarUrl?: string | null;
  isOnline?: boolean;
  lastSeenAt?: string | null;
  nickname?: string | null;
};

// Stacking order is a hard requirement, not a styling choice: real @username
// first, then the nickname (if set) directly below it, then the Spotify
// badge below that — always in that order, this being the one surface where
// both the real identity AND the private override are shown together.
export function ContactInfoModal({
  participant,
  onClose,
  onNicknameChange,
}: {
  participant: Participant;
  onClose: () => void;
  onNicknameChange: (nickname: string | null) => void;
}) {
  const [sharedWithTarget, setSharedWithTarget] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // participant.nickname (from the conversation payload) has the current
  // VALUE already; sharedWithTarget doesn't ride along on that payload since
  // it never affects the owner's own view — fetch it once, specifically for
  // this editor.
  useEffect(() => {
    let cancelled = false;
    void nicknamesApi
      .get(participant.userId)
      .then((info) => { if (!cancelled) setSharedWithTarget(info.sharedWithTarget); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [participant.userId]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function startEditing() {
    setDraft(participant.nickname ?? "");
    setError(null);
    setEditing(true);
  }

  async function save() {
    const nickname = draft.trim();
    if (!nickname) return;
    setSaving(true);
    setError(null);
    try {
      const info = await nicknamesApi.set(participant.userId, { nickname, sharedWithTarget });
      onNicknameChange(info.nickname);
      setEditing(false);
    } catch {
      setError("Couldn't save — try again.");
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    try {
      await nicknamesApi.clear(participant.userId);
      onNicknameChange(null);
      setSharedWithTarget(false);
      setEditing(false);
    } catch {
      setError("Couldn't remove — try again.");
    } finally {
      setSaving(false);
    }
  }

  // The toggle is a per-viewer PREFERENCE the owner is setting for the CURRENT
  // save, not a live PATCH of its own — flipping it only takes effect (and
  // only notifies/emits) the next time Save actually runs, per the
  // idempotent-share-no-renotify rule enforced server-side.
  async function onToggleShare(next: boolean) {
    setSharedWithTarget(next);
    if (!participant.nickname || editing) return; // nothing saved yet to (re)share
    setSaving(true);
    try {
      const info = await nicknamesApi.set(participant.userId, { nickname: participant.nickname, sharedWithTarget: next });
      onNicknameChange(info.nickname);
    } catch {
      setSharedWithTarget(!next); // revert
      setError("Couldn't update sharing — try again.");
    } finally {
      setSaving(false);
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Contact info"
        className="relative flex w-full max-w-sm flex-col overflow-hidden rounded-[24px] border shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
        style={{ background: "var(--color-panel)", borderColor: "var(--color-hairline-strong)" }}
      >
        <header
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--color-hairline)" }}
        >
          <span className="text-[15px] font-bold text-[var(--color-text)]" style={{ fontFamily: display }}>
            Contact info
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/[0.06]"
          >
            <X className="h-4 w-4 text-[var(--color-text-secondary)]" />
          </button>
        </header>

        <div className="flex flex-col items-center gap-4 px-5 py-6">
          <Avatar username={participant.username} src={participant.avatarUrl} size={72} isOnline={participant.isOnline} />

          {/* Fixed order: real @username, nickname (if set), Spotify badge. */}
          <div className="flex flex-col items-center gap-1">
            <span className="text-[16px] font-bold text-[var(--color-text)]" style={{ fontFamily: display }}>
              @{participant.username}
            </span>
            <span className="text-[11px] tracking-[0.04em] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
              {formatLastSeen(participant.lastSeenAt, participant.isOnline)}
            </span>
          </div>

          {editing ? (
            <div className="flex w-full flex-col gap-2">
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value.slice(0, MAX_NICKNAME_LENGTH))}
                onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
                placeholder="Nickname"
                className="w-full rounded-xl border bg-transparent px-3 py-2 text-center text-[14px] text-[var(--color-text)] outline-none focus:border-[var(--color-signal)]"
                style={{ borderColor: "var(--color-hairline-strong)" }}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="flex-1 rounded-xl border px-3 py-2 text-[13px] font-medium text-[var(--color-text-secondary)]"
                  style={{ borderColor: "var(--color-hairline-strong)" }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving || draft.trim().length === 0}
                  className="flex-1 rounded-xl px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
                  style={{ background: "var(--color-signal)" }}
                >
                  Save
                </button>
              </div>
            </div>
          ) : participant.nickname ? (
            <button
              type="button"
              onClick={startEditing}
              className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 hover:bg-white/[0.04]"
              style={{ borderColor: "var(--color-hairline-strong)" }}
            >
              <span className="text-[14px] font-semibold text-[var(--color-text)]">{participant.nickname}</span>
              <Pencil className="h-3 w-3 text-[var(--color-text-muted)]" />
            </button>
          ) : (
            <button
              type="button"
              onClick={startEditing}
              className="rounded-full border border-dashed px-3 py-1.5 text-[13px] text-[var(--color-text-secondary)] hover:bg-white/[0.04]"
              style={{ borderColor: "var(--color-hairline-strong)" }}
            >
              Add nickname
            </button>
          )}

          {error && (
            <span className="text-[11px] text-[var(--color-alert)]">{error}</span>
          )}

          {/* Only relevant once a nickname is set — a bare "share" toggle with
              nothing to share would be meaningless. */}
          {(participant.nickname || editing) && (
            <div
              className="flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5"
              style={{ borderColor: "var(--color-hairline)" }}
            >
              <div className="flex flex-col">
                <span className="text-[13px] font-medium text-[var(--color-text)]">Share nickname</span>
                <span className="text-[11px] text-[var(--color-text-muted)]">
                  Let @{participant.username} see what you call them
                </span>
              </div>
              <Toggle checked={sharedWithTarget} disabled={saving} ariaLabel="Share nickname" onChange={(v) => void onToggleShare(v)} />
            </div>
          )}

          {participant.nickname && !editing && (
            <button
              type="button"
              onClick={() => void clear()}
              disabled={saving}
              className="flex items-center gap-1.5 text-[12px] text-[var(--color-alert)] disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" />
              Remove nickname
            </button>
          )}

          <SpotifyBadge userId={participant.userId} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
