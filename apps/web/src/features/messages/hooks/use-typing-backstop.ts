"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// useTypingBackstop — mirrors an externally-driven "is this person typing"
// signal (fed via `markTyping`), but self-clears after `backstopMs` of no
// further signal at all — a safety net for when the server's own explicit
// typing:stop broadcast (see typing.service.ts) never reaches this client
// (dropped packet, backgrounded sender tab, etc.), which would otherwise
// leave the indicator stuck forever. The server's own broadcast is still the
// PRIMARY path: callers should invoke markTyping(true)/markTyping(false)
// straight off the real typing:update event (and typing:sync-response) —
// this hook only adds a ceiling on how long a `true` can survive with
// nothing corroborating it.
//
// Every markTyping call — true or false — resets the backstop timer, so:
//   - a real stop (the expected/common case) still clears things
//     immediately, exactly as it did before this hook existed.
//   - a stop-then-resume (a real pause long enough for the server to expire
//     and sweep the entry, followed by a fresh typing:update(true)) correctly
//     re-arms the window rather than leaving the old timer to fire early.
// A single markTyping(true) with NOTHING further — true or false — for the
// full window is exactly the "the real stop got lost" case this exists for.
// ─────────────────────────────────────────────────────────────────────────────

export function useTypingBackstop(
  backstopMs: number,
): [isTyping: boolean, markTyping: (isTyping: boolean) => void, clear: () => void] {
  const [isTyping, setIsTyping] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const markTyping = useCallback(
    (typing: boolean) => {
      clear();
      setIsTyping(typing);
      if (typing) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          setIsTyping(false);
        }, backstopMs);
      }
    },
    [backstopMs, clear],
  );

  // Unmount safety net — nothing left running against a torn-down component.
  useEffect(() => clear, [clear]);

  return [isTyping, markTyping, clear];
}
