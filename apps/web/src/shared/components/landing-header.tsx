"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/frontend-core/utils";
import { Wordmark } from "./wordmark";

// Sticky header that fades in a frosted background once the user scrolls
// past the hero — keeps the top edge minimal at rest but anchored when
// scrolling through the longer sections below.
export function LandingHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 transition-colors",
        scrolled
          ? "border-b bg-[var(--color-bg)]/82 backdrop-blur-xl"
          : "border-b border-transparent",
      )}
      style={{ borderColor: scrolled ? "var(--color-hairline)" : undefined }}
    >
      <div className="mx-auto flex w-full max-w-[640px] items-center justify-between px-6 py-4 lg:max-w-[1120px] lg:px-8 lg:py-5">
        <Link href="/" aria-label="Relay home" className="-mx-1 rounded px-1 py-0.5">
          <Wordmark />
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href="/sign-in"
            className="rounded-full px-3.5 py-2 text-[14px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)]"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="hidden items-center gap-1.5 rounded-full bg-[var(--color-signal)] px-4 py-2 text-[14px] font-semibold text-white shadow-[0_4px_12px_rgba(59,130,246,0.30)] transition-opacity hover:opacity-95 lg:inline-flex"
          >
            Create account
          </Link>
        </div>
      </div>
    </header>
  );
}
