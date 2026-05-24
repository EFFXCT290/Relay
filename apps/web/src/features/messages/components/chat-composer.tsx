"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Check, Plus, Send, X } from "lucide-react";
import { TYPING_DEBOUNCE_MS, TYPING_TIMEOUT_MS } from "@relay/contracts";
import type { Message } from "./message-bubble";

type Props = {
  onSend: (body: string, replyToId?: string | null) => Promise<void> | void;
  onUpdate?: (messageId: string, body: string) => Promise<void> | void;
  onTypingChange?: (isTyping: boolean) => void;
  onSendImage?: (file: File) => void;
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
  onSendImage,
  replyTo,
  onCancelReply,
  editing,
  onCancelEdit,
  disabled,
}: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Typing emit policy:
  //   - Emit typing:start ONCE when typing begins, then suppress repeats for
  //     TYPING_DEBOUNCE_MS. After that window any further keystroke re-emits
  //     typing:start so the server refreshes its expiresAt.
  //   - Track inactivity locally: if no keystroke for TYPING_TIMEOUT_MS we
  //     emit typing:stop (cheap, but the server would sweep us anyway).
  //   - Emit typing:stop on empty input, send, edit, or unmount.
  const typingActiveRef = useRef(false);
  const lastStartAtRef = useRef(0);
  const inactivityTimerRef = useRef<number | null>(null);

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
    if (inactivityTimerRef.current !== null) {
      window.clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
    if (typingActiveRef.current) {
      typingActiveRef.current = false;
      lastStartAtRef.current = 0;
      onTypingChange?.(false);
    }
  };

  const noteKeystroke = () => {
    const now = Date.now();
    // Debounce: emit typing:start only on the first keystroke after a
    // TYPING_DEBOUNCE_MS-wide quiet window. Server uses this to refresh
    // its expiresAt without us spamming the socket on every keypress.
    if (!typingActiveRef.current || now - lastStartAtRef.current >= TYPING_DEBOUNCE_MS) {
      typingActiveRef.current = true;
      lastStartAtRef.current = now;
      onTypingChange?.(true);
    }
    if (inactivityTimerRef.current !== null) {
      window.clearTimeout(inactivityTimerRef.current);
    }
    inactivityTimerRef.current = window.setTimeout(stopTyping, TYPING_TIMEOUT_MS);
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
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onSendImage?.(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            aria-label="Send image"
            disabled={!onSendImage || busy || disabled}
            onClick={() => fileInputRef.current?.click()}
            className="mb-1 text-[var(--color-text-secondary)] transition-opacity disabled:opacity-40 hover:text-[var(--color-text)]"
          >
            <Camera className="h-[18px] w-[18px]" />
          </button>
        </div>

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
      </div>
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
