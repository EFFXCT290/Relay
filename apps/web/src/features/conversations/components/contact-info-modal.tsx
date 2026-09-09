"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronRight, Images, Pencil, Phone, Pin, Search, Trash2, Video, X } from "lucide-react";
import { Avatar } from "@/shared/components/avatar";
import { Toggle } from "@/shared/components/toggle";
import { SpotifyBadge } from "@/features/spotify/spotify-badge";
import { nicknamesApi } from "@/frontend-core/api-client/nicknames";
import { mediaApi } from "@/frontend-core/api-client/media";
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

function formatChattingSince(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

// Stacking order is a hard requirement, not a styling choice: real @username
// first, then the nickname (if set) directly below it, then the Spotify
// badge below that — always in that order, this being the one surface where
// both the real identity AND the private override are shown together.
//
// This is the single "Contact info" surface — desktop centered modal /
// mobile full page, switching purely on the `lg:` breakpoint (same
// CSS-only, one-tree convention as PinnedMessagesList; no JS media query).
// It owns nickname editing (pre-existing) AND the fuller profile screen
// (voice/video/search actions, shared-media + pinned counts) — there is
// exactly one nickname-editing surface in the app, this one.
export function ContactInfoModal({
  participant,
  conversationId,
  conversationCreatedAt,
  pinCount,
  onClose,
  onNicknameChange,
  onOpenMedia,
  onOpenPinned,
  onStartVoiceCall,
  onStartVideoCall,
}: {
  participant: Participant;
  conversationId: string;
  conversationCreatedAt: string;
  pinCount: number;
  onClose: () => void;
  onNicknameChange: (nickname: string | null) => void;
  onOpenMedia: () => void;
  onOpenPinned: () => void;
  onStartVoiceCall: () => void;
  onStartVideoCall: () => void;
}) {
  const [sharedWithTarget, setSharedWithTarget] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mediaCount, setMediaCount] = useState<number | null>(null);
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

  // Only the count is needed here (the Info Card badge) — the full gallery
  // is fetched by SharedMediaGrid itself once opened, so limit:1 keeps this
  // fetch cheap.
  useEffect(() => {
    let cancelled = false;
    void mediaApi
      .gallery(conversationId, undefined, 1)
      .then((res) => { if (!cancelled) setMediaCount(res.totalCount); })
      .catch(() => { if (!cancelled) setMediaCount(0); });
    return () => { cancelled = true; };
  }, [conversationId]);

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
    <div className="fixed inset-0 z-[150] flex flex-col">
      <div
        className="absolute inset-0 hidden lg:block"
        style={{ background: "#000000B8" }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Contact info"
        className="relative z-10 flex w-full flex-1 flex-col overflow-hidden lg:mx-auto lg:mt-16 lg:mb-auto lg:h-auto lg:max-h-[85vh] lg:w-[420px] lg:flex-none lg:rounded-[20px] lg:border lg:shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
        style={{ background: "var(--color-bg)", borderColor: "var(--color-hairline-strong)" }}
      >
        <header
          className="flex shrink-0 items-center gap-2 pt-[calc(env(safe-area-inset-top)+10px)] pr-3 pb-[14px] pl-1 lg:gap-0 lg:pt-[18px] lg:pr-4 lg:pb-[10px] lg:pl-5"
        >
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="order-first flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full hover:bg-white/5 lg:order-last lg:h-[30px] lg:w-[30px] lg:bg-[var(--color-panel)]"
          >
            <ArrowLeft className="h-[22px] w-[22px] text-[var(--color-text)] lg:hidden" />
            <X className="hidden h-4 w-4 text-[var(--color-text)] lg:block" />
          </button>
          <span
            className="flex-1 text-center text-[16px] font-bold text-[var(--color-text)] lg:text-left lg:text-[15px]"
            style={{ fontFamily: display }}
          >
            Contact info
          </span>
          <div className="h-[38px] w-[38px] shrink-0 lg:hidden" />
        </header>

        <div className="flex flex-1 flex-col items-center gap-6 overflow-y-auto px-5 pt-2 pb-[calc(env(safe-area-inset-bottom)+32px)] lg:flex-none lg:gap-[22px] lg:px-6 lg:pt-[6px] lg:pb-7">
          <div className="flex w-full flex-col items-center gap-2.5">
            <Avatar username={participant.username} src={participant.avatarUrl} size={96} isOnline={participant.isOnline} />

            <span className="text-[22px] font-bold text-[var(--color-text)] lg:text-[20px]" style={{ fontFamily: display }}>
              {participant.username}
            </span>
            <span className="text-[12px] tracking-[0.04em] text-[var(--color-text-secondary)]" style={{ fontFamily: mono }}>
              @{participant.username}  ·  {formatLastSeen(participant.lastSeenAt, participant.isOnline)}
            </span>

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

          <div className="flex w-full gap-3">
            <button
              type="button"
              onClick={onStartVoiceCall}
              className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-2xl border py-3.5"
              style={{ background: "var(--color-panel)", borderColor: "var(--color-hairline)" }}
            >
              <Phone className="h-5 w-5" style={{ color: "var(--color-signal)" }} />
              <span className="text-[12px] font-semibold text-[var(--color-text)]">Voice</span>
            </button>
            <button
              type="button"
              onClick={onStartVideoCall}
              className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-2xl border py-3.5"
              style={{ background: "var(--color-panel)", borderColor: "var(--color-hairline)" }}
            >
              <Video className="h-5 w-5" style={{ color: "var(--color-signal)" }} />
              <span className="text-[12px] font-semibold text-[var(--color-text)]">Video</span>
            </button>
            {/* No destination exists yet for in-thread search — kept as an
                inert placeholder rather than a live dead end. */}
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-2xl border py-3.5 opacity-40"
              style={{ background: "var(--color-panel)", borderColor: "var(--color-hairline)" }}
            >
              <Search className="h-5 w-5" style={{ color: "var(--color-signal)" }} />
              <span className="text-[12px] font-semibold text-[var(--color-text)]">Search</span>
            </button>
          </div>

          <div
            className="flex w-full flex-col rounded-2xl border"
            style={{ background: "var(--color-panel)", borderColor: "var(--color-hairline)" }}
          >
            <button
              type="button"
              onClick={onOpenMedia}
              className="flex items-center gap-3 px-4 py-3.5"
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]"
                style={{ background: "var(--color-raised)" }}
              >
                <Images className="h-4 w-4 text-[var(--color-text)]" />
              </span>
              <span className="flex-1 text-left text-[14px] font-medium text-[var(--color-text)]">
                Media, links and docs
              </span>
              <span className="text-[13px] text-[var(--color-text-secondary)]" style={{ fontFamily: mono }}>
                {mediaCount ?? "—"}
              </span>
              <ChevronRight className="h-4 w-4 text-[var(--color-text-muted)]" />
            </button>

            <div className="h-px w-full" style={{ background: "var(--color-hairline)" }} />

            <button
              type="button"
              onClick={onOpenPinned}
              className="flex items-center gap-3 px-4 py-3.5"
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]"
                style={{ background: "var(--color-raised)" }}
              >
                <Pin className="h-4 w-4 text-[var(--color-text)]" />
              </span>
              <span className="flex-1 text-left text-[14px] font-medium text-[var(--color-text)]">
                Pinned messages
              </span>
              <span className="text-[13px] text-[var(--color-text-secondary)]" style={{ fontFamily: mono }}>
                {pinCount}
              </span>
              <ChevronRight className="h-4 w-4 text-[var(--color-text-muted)]" />
            </button>

            <span
              className="px-4 py-2.5 text-center text-[11px] text-[var(--color-text-muted)]"
              style={{ fontFamily: mono }}
            >
              Chatting since {formatChattingSince(conversationCreatedAt)}
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
