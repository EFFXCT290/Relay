"use client";

import { useEffect, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// useIdle — returns isActive. Resets on mousemove / touchstart / keydown, then
// flips to false after `timeoutMs` of silence. When `enabled` is false the hook
// short-circuits to always-active (no listeners, no timer) — callers use that to
// opt incoming-call / pre-connected phases out of auto-hide entirely.
//
// Window-level listeners on purpose: a click on any button inside the call UI
// bubbles up here for free, so the controls don't vanish mid-press. If a future
// surface (draggable PiP, Phase 7.5) needs to be invisible to this hook, it
// must mark its own events — either stopPropagation, or a closest() check added
// inside this handler. Flag with `// 7.5: PiP must not feed useIdle`.
// ─────────────────────────────────────────────────────────────────────────────

export function useIdle(timeoutMs = 2500, enabled = true): boolean {
  const [isActive, setIsActive] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Disabled means always-active; clear any timer left from a previous run.
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      setIsActive(true);
      return;
    }

    const arm = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setIsActive(false), timeoutMs);
    };

    const onActivity = () => {
      // Coalesce: only call setState when the value actually changes, so frequent
      // mousemove doesn't trigger a render every event.
      setIsActive((prev) => (prev ? prev : true));
      arm();
    };

    window.addEventListener("mousemove",  onActivity, { passive: true });
    window.addEventListener("touchstart", onActivity, { passive: true });
    window.addEventListener("keydown",    onActivity);

    arm();

    return () => {
      window.removeEventListener("mousemove",  onActivity);
      window.removeEventListener("touchstart", onActivity);
      window.removeEventListener("keydown",    onActivity);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [timeoutMs, enabled]);

  return isActive;
}
