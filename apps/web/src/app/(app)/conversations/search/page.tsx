"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
import { api } from "@/frontend-core/api";
import { Avatar } from "@/shared/components/avatar";
import { Input } from "@/shared/ui/input";
import type { ConversationSearchHit } from "@relay/contracts";

const mono = "var(--font-mono)";
const display = "var(--font-display)";
const MIN_Q = 2;

// Global inbox search — the real destination behind the inbox header's
// Search icon (apps/web/src/app/(app)/conversations/page.tsx). Live-as-you-
// type across every conversation the caller has accepted, matching either
// the other participant's name or message/transcript content. Mirrors
// new/page.tsx's debounce + AbortController pattern exactly.
export default function ConversationSearchPage() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ConversationSearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (q.trim().length < MIN_Q) {
      setResults(null);
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
        const res = await api<{ results: ConversationSearchHit[] }>(
          `/api/conversations/search?q=${encodeURIComponent(q.trim())}`,
          { signal: ctrl.signal },
        );
        if (!ctrl.signal.aborted) {
          setResults(res.results);
          setLoading(false);
        }
      } catch (err) {
        if (!ctrl.signal.aborted) {
          setError(err instanceof Error ? err.message : "Search failed");
          setResults([]);
          setLoading(false);
        }
      }
    }, 220);

    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

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
          Search
        </h1>
      </header>

      <div className="px-4 pb-3 lg:px-6">
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-secondary)]" />
          <Input
            autoFocus
            type="text"
            placeholder="Search conversations…"
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
          Type at least {MIN_Q} characters · {results === null ? "—" : `${results.length} match${results.length === 1 ? "" : "es"}`}
        </p>
      </div>

      {q.trim().length < MIN_Q ? (
        <div className="px-6 py-12 text-center text-sm text-[var(--color-text-secondary)]">
          Search by username, nickname, or message content.
        </div>
      ) : loading ? (
        <ul className="flex flex-col">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-3.5 px-6 py-3">
              <div className="h-11 w-11 shrink-0 animate-pulse rounded-full bg-white/5" />
              <div className="flex flex-1 flex-col gap-2">
                <div className="h-3.5 w-24 animate-pulse rounded bg-white/5" />
                <div className="h-3 w-3/5 animate-pulse rounded bg-white/5" />
              </div>
            </li>
          ))}
        </ul>
      ) : results && results.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <p className="text-sm text-[var(--color-text-secondary)]">
            No matches for <span style={{ fontFamily: mono, color: "var(--color-text)" }}>{q}</span>.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col">
          {(results ?? []).map((hit) => (
            <li key={hit.conversationId}>
              <SearchResultRow hit={hit} />
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

function SearchResultRow({ hit }: { hit: ConversationSearchHit }) {
  const { participant } = hit;
  const displayName = participant.nickname ?? participant.username;

  return (
    <Link
      href={`/conversations/${hit.conversationId}`}
      className="flex w-full items-center gap-3.5 px-6 py-3 text-left transition-colors hover:bg-white/[0.02]"
    >
      <Avatar username={displayName} src={participant.avatarUrl} size={44} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className="truncate text-[16px] font-bold tracking-[-0.01em] text-[var(--color-text)]"
          style={{ fontFamily: display }}
        >
          {participant.nickname ? participant.nickname : `@${participant.username}`}
        </span>
        <span className="truncate text-[13px] text-[var(--color-text-secondary)]">
          {hit.matchType === "content" && hit.snippet ? hit.snippet : `@${participant.username}`}
        </span>
      </div>
    </Link>
  );
}
