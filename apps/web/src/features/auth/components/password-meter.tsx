"use client";

import { cn } from "@/frontend-core/utils";

const MIN_LENGTH = 12;

// 4-tier strength assessment. We weight length above character variety because
// the spec's only hard requirement is the 12-char floor — anything past that
// is bonus credit for diverse character classes.
function score(password: string): { tier: 0 | 1 | 2 | 3 | 4; label: string; color: string } {
  if (password.length === 0) return { tier: 0, label: "—", color: "var(--color-text-muted)" };
  if (password.length < MIN_LENGTH) {
    return { tier: 1, label: `${MIN_LENGTH - password.length} more`, color: "var(--color-alert)" };
  }

  const variety = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;

  // Length floor of 12 + at least 2 character classes → "Strong"
  if (password.length >= 20 && variety >= 3) {
    return { tier: 4, label: "Excellent", color: "var(--color-online)" };
  }
  if (password.length >= 16 && variety >= 2) {
    return { tier: 3, label: "Strong", color: "var(--color-online)" };
  }
  if (variety >= 2) {
    return { tier: 3, label: "Strong", color: "var(--color-online)" };
  }
  return { tier: 2, label: "Fair", color: "var(--color-warning)" };
}

export function PasswordMeter({ password }: { password: string }) {
  const { tier, label, color } = score(password);

  return (
    <div className="flex flex-col gap-2 px-1 pt-1">
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={cn("h-1 flex-1 rounded-full transition-colors")}
            style={{ background: i <= tier ? color : "rgba(255,255,255,0.10)" }}
          />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color }}>
          {label}
        </span>
        <span
          className="text-[11px] text-[var(--color-text-muted)]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {password.length} / {MIN_LENGTH} min
        </span>
      </div>
    </div>
  );
}
