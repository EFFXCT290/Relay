"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Search } from "lucide-react";
import { api } from "@/frontend-core/api";
import { Avatar } from "@/shared/components/avatar";
import { Input } from "@/shared/ui/input";

type SearchHit = { userId: string; username: string };

const mono = "var(--font-mono)";
const display = "var(--font-display)";
const MIN_Q = 2;

export default function NewMessagePage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Debounced search — re-fires 220ms after the user stops typing, and cancels
  // any in-flight request so results never race ahead of the current input.
  useEffect(() => {
    if (q.trim().length < MIN_Q) {
      setHits(null);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;

    setLoading(true);
    setError(null);

    const t = setTimeout(async () => {
      try {
        const res = await api<{ users: SearchHit[] }>(
          `/api/users/search?q=${encodeURIComponent(q.trim())}&limit=20`,
          { signal: ctrl.signal },
        );
        if (!ctrl.signal.aborted) {
          setHits(res.users);
          setLoading(false);
        }
      } catch (err) {
        if (!ctrl.signal.aborted) {
          setError(err instanceof Error ? err.message : "Search failed");
          setHits([]);
          setLoading(false);
        }
      }
    }, 220);

    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const startConversation = async (target: SearchHit) => {
    setBusyUserId(target.userId);
    try {
      const conv = await api<{ conversationId: string }>("/api/conversations", {
        method: "POST",
        body: { participantId: target.userId },
      });
      router.push(`/conversations/${conv.conversationId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start conversation");
      setBusyUserId(null);
    }
  };

  return (
    <div className="flex flex-col">
      <header className="flex items-center gap-3 px-4 pt-4 pb-3 lg:px-6 lg:pt-10">
        <Link
          href="/conversations"
          aria-label="Back"
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/5"
        >
          <ArrowLeft className="h-5 w-5 text-[var(--color-text)]" />
        </Link>
        <h1
          className="text-[22px] font-extrabold tracking-[-0.02em] text-[var(--color-text)] lg:text-[28px]"
          style={{ fontFamily: display }}
        >
          New message
        </h1>
      </header>

      <div className="px-4 pb-3 lg:px-6">
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-secondary)]" />
          <Input
            autoFocus
            type="text"
            placeholder="Search by username…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={{ fontFamily: mono, paddingLeft: 40 }}
          />
        </div>
        <p
          className="mt-2 px-1 text-[11px] text-[var(--color-text-muted)]"
          style={{ fontFamily: mono }}
        >
          Type at least {MIN_Q} characters · {hits === null ? "—" : `${hits.length} match${hits.length === 1 ? "" : "es"}`}
        </p>
      </div>

      {q.trim().length < MIN_Q ? (
        <div className="px-6 py-12 text-center text-sm text-[var(--color-text-secondary)]">
          Search for someone to start a conversation.
        </div>
      ) : loading ? (
        <ul className="flex flex-col">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-3.5 px-6 py-3">
              <div className="h-11 w-11 shrink-0 animate-pulse rounded-full bg-white/5" />
              <div className="h-3.5 w-24 animate-pulse rounded bg-white/5" />
            </li>
          ))}
        </ul>
      ) : hits && hits.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <p className="text-sm text-[var(--color-text-secondary)]">
            No one matches <span style={{ fontFamily: mono, color: "var(--color-text)" }}>@{q}</span>.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col">
          {(hits ?? []).map((user) => (
            <li key={user.userId}>
              <button
                onClick={() => startConversation(user)}
                disabled={busyUserId === user.userId}
                className="flex w-full items-center gap-3.5 px-6 py-3 text-left transition-colors hover:bg-white/[0.02] disabled:opacity-60"
              >
                <Avatar username={user.username} size={44} />
                <div className="flex flex-1 flex-col gap-0.5">
                  <span
                    className="text-[16px] font-bold tracking-[-0.01em] text-[var(--color-text)]"
                    style={{ fontFamily: display }}
                  >
                    @{user.username}
                  </span>
                  <span
                    className="text-[11px] text-[var(--color-text-muted)]"
                    style={{ fontFamily: mono }}
                  >
                    Tap to start a new conversation
                  </span>
                </div>
                {busyUserId === user.userId && (
                  <span
                    className="text-[11px] text-[var(--color-signal)]"
                    style={{ fontFamily: mono }}
                  >
                    starting…
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="px-6 pt-2 text-xs text-[var(--color-alert)]">{error}</p>
      )}
    </div>
  );
}
