"use client";

import { cn } from "@/frontend-core/utils";

type Props = {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
};

export function Toggle({ checked, onChange, disabled, ariaLabel }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        "flex h-6 w-[42px] shrink-0 items-center rounded-full p-0.5 transition-colors",
        "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]",
        checked
          ? "bg-[var(--color-signal)]"
          : "bg-white/[0.10]",
        disabled && "opacity-40",
      )}
    >
      <span
        className={cn(
          "block h-5 w-5 rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.30)] transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0",
        )}
      />
    </button>
  );
}
