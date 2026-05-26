"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Check, Mic, Plus, Send, Trash2, X } from "lucide-react";
import { TYPING_DEBOUNCE_MS } from "@relay/contracts";
import type { Message } from "./message-bubble";
import { useVoiceRecorder } from "../hooks/use-voice-recorder";

// Discard takes below this — a stray tap rather than a deliberate recording.
const MIN_VOICE_MS = 700;

function fmtElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

type Props = {
  onSend: (body: string, replyToId?: string | null) => Promise<void> | void;
  onUpdate?: (messageId: string, body: string) => Promise<void> | void;
  onTypingChange?: (isTyping: boolean) => void;
  onSendImages?: (files: File[]) => void;
  onSendVoice?: (blob: Blob, durationMs: number) => void;
  /** When set, composer renders in reply mode with the parent preview above. */
  replyTo?: Message | null;
  onCancelReply?: () => void;
  /** When set, composer renders in edit mode with the existing body pre-filled. */
  editing?: Message | null;
  onCancelEdit?: () => void;
  disabled?: boolean;
};

const mono = "var(--font-mono)";

export function ChatComposer({
  onSend,
  onUpdate,
  onTypingChange,
  onSendImages,
  onSendVoice,
  replyTo,
  onCancelReply,
  editing,
  onCancelEdit,
  disabled,
}: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const recorder = useVoiceRecorder();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Typing emit policy:
  //   - Emit typing:start ONCE when typing begins, then suppress repeats for
  //     TYPING_DEBOUNCE_MS. After that window any further keystroke re-emits
  //     typing:start so the server refreshes its expiresAt.
  //   - Emit typing:stop on: empty input, send, edit mode, or unmount.
  //   - No client-side expiry timer — the server sweep is the sole authority.
  const typingActiveRef = useRef(false);
  const lastStartAtRef = useRef(0);

  // When entering edit mode, seed the textarea; when leaving, clear it.
  useEffect(() => {
    if (editing) {
      setValue(editing.body ?? "");
      taRef.current?.focus();
    } else {
      setValue("");
    }
  }, [editing]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [value]);

  const stopTyping = () => {
    if (typingActiveRef.current) {
      typingActiveRef.current = false;
      lastStartAtRef.current = 0;
      onTypingChange?.(false);
    }
  };

  const noteKeystroke = () => {
    const now = Date.now();
    // Emit typing:start only on the first keystroke or after DEBOUNCE_MS of
    // silence — server uses this to refresh expiresAt without being spammed.
    if (!typingActiveRef.current || now - lastStartAtRef.current >= TYPING_DEBOUNCE_MS) {
      typingActiveRef.current = true;
      lastStartAtRef.current = now;
      onTypingChange?.(true);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    if (editing) return; // typing indicator is for new messages only
    if (e.target.value.length === 0) stopTyping();
    else noteKeystroke();
  };

  const submit = async () => {
    const body = value.trim();
    if (!body || busy || disabled) return;
    setBusy(true);
    stopTyping();
    try {
      if (editing) {
        await onUpdate?.(editing.messageId, body);
      } else {
        await onSend(body, replyTo?.messageId ?? null);
      }
      setValue("");
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      if (editing) onCancelEdit?.();
      else if (replyTo) onCancelReply?.();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  useEffect(() => () => stopTyping(), []);

  const startRecording = async () => {
    if (disabled || busy) return;
    try {
      await recorder.start();
    } catch {
      // Mic permission denied or unavailable — silently no-op.
    }
  };

  const sendRecording = async () => {
    const rec = await recorder.stop();
    if (rec && rec.durationMs >= MIN_VOICE_MS) onSendVoice?.(rec.blob, rec.durationMs);
  };

  const cancelRecording = () => { void recorder.cancel(); };

  const canRecord = !!onSendVoice && recorder.supported && !editing;
  const showMic   = canRecord && !value.trim();

  return (
    <div
      className="flex flex-col border-t bg-[var(--color-bg)]/92 px-4 pt-3 pb-2 backdrop-blur-xl"
      style={{ borderColor: "var(--color-hairline)" }}
    >
      {(replyTo || editing) && (
        <ReplyOrEditChip
          message={(editing ?? replyTo)!}
          mode={editing ? "edit" : "reply"}
          onCancel={() => (editing ? onCancelEdit?.() : onCancelReply?.())}
        />
      )}

      {recorder.recording ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={cancelRecording}
            aria-label="Cancel recording"
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full border bg-[var(--color-raised)] text-[var(--color-alert)] disabled:opacity-40"
            style={{ borderColor: "var(--color-hairline)" }}
          >
            <Trash2 className="h-[18px] w-[18px]" />
          </button>
          <div
            className="flex flex-1 items-center gap-2 rounded-[20px] border bg-[var(--color-panel)] px-4 py-2.5"
            style={{ borderColor: "var(--color-hairline)" }}
          >
            <span className="relay-typing-dot h-2.5 w-2.5 rounded-full" style={{ background: "var(--color-alert)" }} />
            <span className="text-[13px] tabular-nums text-[var(--color-text)]" style={{ fontFamily: mono }}>
              {fmtElapsed(recorder.elapsedMs)}
            </span>
            <span className="text-[12px] text-[var(--color-text-muted)]">Recording…</span>
          </div>
          <button
            type="button"
            onClick={() => void sendRecording()}
            aria-label="Send voice message"
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full text-white shadow-[0_4px_12px_rgba(59,130,246,0.30)]"
            style={{ background: "var(--color-signal)" }}
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      ) : (
      <div className="flex items-end gap-2">
        <button
          type="button"
          aria-label="Add"
          disabled
          className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full border bg-[var(--color-raised)] text-[var(--color-text-secondary)] disabled:opacity-40"
          style={{ borderColor: "var(--color-hairline)" }}
        >
          <Plus className="h-[18px] w-[18px]" />
        </button>

        <div
          className="flex flex-1 items-end gap-2 rounded-[20px] border bg-[var(--color-panel)] px-3 py-1.5"
          style={{ borderColor: "var(--color-hairline)" }}
        >
          <textarea
            ref={taRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={editing ? "Edit message…" : "Message…"}
            className="flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-5 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
            style={{ fontFamily: "var(--font-body)" }}
            disabled={busy || disabled}
            aria-label="Message"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) onSendImages?.(files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            aria-label="Send image"
            disabled={!onSendImages || busy || disabled}
            onClick={() => fileInputRef.current?.click()}
            className="mb-1 text-[var(--color-text-secondary)] transition-opacity disabled:opacity-40 hover:text-[var(--color-text)]"
          >
            <Camera className="h-[18px] w-[18px]" />
          </button>
        </div>

        {showMic ? (
          <button
            type="button"
            onClick={() => void startRecording()}
            disabled={busy || disabled}
            aria-label="Record voice message"
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full text-white shadow-[0_4px_12px_rgba(59,130,246,0.30)] transition-opacity disabled:opacity-40"
            style={{ background: "var(--color-signal)" }}
          >
            <Mic className="h-[18px] w-[18px]" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!value.trim() || busy || disabled}
            aria-label={editing ? "Save edit" : "Send"}
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full text-white shadow-[0_4px_12px_rgba(59,130,246,0.30)] transition-opacity disabled:opacity-40"
            style={{ background: "var(--color-signal)" }}
          >
            {editing ? <Check className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </button>
        )}
      </div>
      )}
      <span
        className="px-1 pt-1 text-[10px] text-[var(--color-text-muted)]"
        style={{ fontFamily: mono }}
      >
        {editing ? "Enter to save · Esc to cancel" : "Enter to send · Shift+Enter for newline"}
      </span>
    </div>
  );
}

function ReplyOrEditChip({
  message,
  mode,
  onCancel,
}: {
  message: Message;
  mode: "reply" | "edit";
  onCancel: () => void;
}) {
  return (
    <div
      className="mb-2 flex items-start gap-3 rounded-[14px] border bg-[var(--color-panel)] px-3 py-2"
      style={{ borderColor: "var(--color-hairline)", borderLeft: "2px solid var(--color-signal)" }}
    >
      <div className="flex flex-1 flex-col gap-0.5">
        <span
          className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-signal)]"
          style={{ fontFamily: mono }}
        >
          {mode === "reply" ? `Replying to @${message.senderUsername}` : "Editing message"}
        </span>
        <span className="truncate text-[12px] text-[var(--color-text-secondary)]">
          {message.body ?? "(media)"}
        </span>
      </div>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
