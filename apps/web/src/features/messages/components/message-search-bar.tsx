"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { api } from "@/frontend-core/api";
import type { MessageSearchHit } from "@relay/contracts";

const mono = "var(--font-mono)";

type Props = {
  conversationId: string;
  onClose: () => void;
  /** Called whenever the active match changes (on new results, or on arrow nav) so the thread can jump + flash it. */
  onJumpToMessage: (messageId: string) => void;
  /** Mirrors the raw input text back up so MessageBubble can highlight matches inline. */
  onQueryChange: (query: string) => void;
};

// WhatsApp-style per-conversation search bar. Replaces the header's contact-
// info/call/video/more row while open (this IS "overlaying the header" on
// mobile; on desktop the trigger icon that opens this sits right next to the
// call/video icons it temporarily displaces — same component, same
// behavior, both breakpoints). Hits are most-recent-first (see the backend
// route); opening the bar jumps straight to hits[0].
export function MessageSearchBar({ conversationId, onClose, onJumpToMessage, onQueryChange }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MessageSearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    onQueryChange(query);
    const q = query.trim();
    if (!q) {
      abortRef.current?.abort();
      setHits([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    setLoading(true);

    const t = setTimeout(async () => {
      try {
        const res = await api<{ hits: MessageSearchHit[] }>(
          `/api/conversations/${conversationId}/messages/search?q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal },
        );
        if (ctrl.signal.aborted) return;
        setHits(res.hits);
        setActiveIndex(0);
        setLoading(false);
        if (res.hits.length > 0) onJumpToMessage(res.hits[0]!.messageId);
      } catch {
        if (!ctrl.signal.aborted) {
          setHits([]);
          setLoading(false);
        }
      }
    }, 250);

    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, conversationId]);

  const goTo = (delta: number) => {
    if (hits.length === 0) return;
    const next = (activeIndex + delta + hits.length) % hits.length;
    setActiveIndex(next);
    onJumpToMessage(hits[next]!.messageId);
  };

  return (
    <header
      className="flex items-center gap-2 border-b bg-[var(--color-bg)]/92 px-4 py-2 backdrop-blur-xl"
      style={{ borderColor: "var(--color-hairline)" }}
    >
      <Search className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); goTo(e.shiftKey ? -1 : 1); }
          if (e.key === "Escape") onClose();
        }}
        placeholder="Search in conversation"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="h-9 min-w-0 flex-1 rounded-full border bg-[var(--color-panel)] px-3.5 text-[14px] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none"
        style={{ borderColor: "var(--color-hairline-strong)" }}
      />
      {query.trim() && !loading && (
        <span
          className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-muted)]"
          style={{ fontFamily: mono }}
        >
          {hits.length === 0 ? "0 of 0" : `${activeIndex + 1} of ${hits.length}`}
        </span>
      )}
      <button
        type="button"
        aria-label="Previous match"
        disabled={hits.length === 0}
        onClick={() => goTo(-1)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-white/5 disabled:opacity-30"
      >
        <ChevronUp className="h-4 w-4 text-[var(--color-text)]" />
      </button>
      <button
        type="button"
        aria-label="Next match"
        disabled={hits.length === 0}
        onClick={() => goTo(1)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-white/5 disabled:opacity-30"
      >
        <ChevronDown className="h-4 w-4 text-[var(--color-text)]" />
      </button>
      <button
        type="button"
        aria-label="Close search"
        onClick={onClose}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-white/5"
      >
        <X className="h-4 w-4 text-[var(--color-text)]" />
      </button>
    </header>
  );
}
