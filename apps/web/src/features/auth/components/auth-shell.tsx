import Link from "next/link";
import { ArrowLeft, Shield, Eye, ShieldOff, Lock } from "lucide-react";
import { Wordmark } from "@/shared/components/wordmark";
import { SegmentedTabs } from "@/shared/components/segmented-tabs";

type Mode = "sign-in" | "sign-up";

type Props = {
  mode: Mode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
};

const display = "var(--font-display)";
const mono = "var(--font-mono)";

export function AuthShell({ mode, title, subtitle, children }: Props) {
  return (
    <main className="flex min-h-dvh w-full">
      {/* ── Brand panel — desktop only ──────────────────────────────────── */}
      <BrandPanel />

      {/* ── Form column ─────────────────────────────────────────────────── */}
      <div className="flex w-full flex-1 flex-col lg:w-1/2 lg:max-w-[640px]">
        {/* Mobile-only top nav */}
        <header className="flex items-center justify-between px-4 pt-4 pb-2 lg:hidden">
          <Link
            href="/"
            aria-label="Back"
            className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-text)] hover:bg-white/5"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <Wordmark size={20} />
          <span className="h-10 w-10" aria-hidden />
        </header>

        {/* Centered content (desktop vertically centers; mobile stacks) */}
        <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col px-6 pt-10 lg:max-w-[480px] lg:justify-center lg:px-12 lg:pt-0">
          {/* Title block */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5">
              <span
                className="relay-pulse block h-1.5 w-1.5 rounded-full"
                style={{ background: "var(--color-signal)" }}
              />
              <span
                className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--color-text-secondary)]"
                style={{ fontFamily: mono }}
              >
                {mode === "sign-up" ? "Welcome" : "Welcome back"}
              </span>
            </div>
            <h1
              className="text-[40px] font-extrabold leading-[42px] tracking-[-0.025em] text-[var(--color-text)] lg:text-[48px] lg:leading-[50px]"
              style={{ fontFamily: display }}
            >
              {title}
              <span style={{ color: "var(--color-signal)" }}>.</span>
            </h1>
            <p className="max-w-[360px] text-[15px] leading-[22px] text-[var(--color-text-secondary)]">
              {subtitle}
            </p>
          </section>

          {/* Tabs */}
          <section className="pt-7">
            <SegmentedTabs
              tabs={[
                { label: "Sign in", href: "/sign-in" },
                { label: "Create account", href: "/sign-up" },
              ]}
              active={mode === "sign-in" ? 0 : 1}
            />
          </section>

          {/* Form */}
          <section className="pt-6">{children}</section>

          {/* Security note */}
          <section className="pt-8">
            <div
              className="flex items-start gap-3 rounded-2xl border p-4"
              style={{
                background: "var(--color-panel)",
                borderColor: "var(--color-hairline)",
              }}
            >
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border"
                style={{
                  background: "rgba(59,130,246,0.10)",
                  borderColor: "rgba(59,130,246,0.20)",
                }}
              >
                <Shield className="h-3.5 w-3.5" style={{ color: "var(--color-signal)" }} />
              </div>
              <div className="flex flex-1 flex-col gap-0.5">
                <p className="text-[13px] font-semibold text-[var(--color-text)]">
                  No recovery, no shortcuts
                </p>
                <p className="text-[13px] leading-[18px] text-[var(--color-text-secondary)]">
                  Forget your password and the account is gone. We don't keep what we can't read.
                </p>
              </div>
            </div>
          </section>
        </div>

        {/* Footer — terms + swap-mode link */}
        <section className="mx-auto flex w-full max-w-[440px] flex-col gap-5 px-6 pt-8 pb-10 lg:max-w-[480px] lg:px-12">
          <p className="self-center text-center text-xs leading-[17px] text-[var(--color-text-muted)]">
            By {mode === "sign-up" ? "creating an account" : "signing in"} you accept the{" "}
            <Link href="/terms" className="font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">
              Privacy Policy
            </Link>
            .
          </p>
          <div className="flex items-center justify-center gap-1.5">
            <span className="text-[13px] text-[var(--color-text-secondary)]">
              {mode === "sign-up" ? "Already have an account?" : "New to Relay?"}
            </span>
            <Link
              href={mode === "sign-up" ? "/sign-in" : "/sign-up"}
              className="flex items-center gap-1 text-[13px] font-semibold text-[var(--color-signal)] hover:underline"
            >
              {mode === "sign-up" ? "Sign in" : "Create one"}
              <span aria-hidden>→</span>
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}

// ──────────────────────────────────────────────────────────────────────────
//  Brand panel (desktop only) — wordmark, hero, three pillars, signal arc
// ──────────────────────────────────────────────────────────────────────────

function BrandPanel() {
  return (
    <aside
      className="relative hidden flex-col justify-between overflow-hidden border-r bg-[var(--color-panel)] p-16 lg:flex lg:w-1/2 lg:max-w-[720px]"
      style={{ borderColor: "var(--color-hairline)" }}
    >
      {/* Top — wordmark */}
      <div className="relative z-10">
        <Wordmark size={26} />
      </div>

      {/* Middle — hero + bullets */}
      <div className="relative z-10 flex flex-col gap-10">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <span
              className="relay-pulse block h-1.5 w-1.5 rounded-full"
              style={{ background: "var(--color-signal)" }}
            />
            <span
              className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--color-text-secondary)]"
              style={{ fontFamily: mono }}
            >
              Private · Direct · Ephemeral
            </span>
          </div>
          <h2
            className="text-[64px] font-extrabold leading-[64px] tracking-[-0.03em] text-[var(--color-text)]"
            style={{ fontFamily: display }}
          >
            A secure way
            <br />
            to message<span style={{ color: "var(--color-signal)" }}>.</span>
          </h2>
          <p className="max-w-[440px] text-[16px] leading-[24px] text-[var(--color-text-secondary)]">
            Direct messages with view limits, capture forensics, and a 30-second media window.
            Built for things meant to be temporary.
          </p>
        </div>

        <ul className="flex flex-col gap-5">
          <BrandBullet
            icon={<Eye className="h-4 w-4" style={{ color: "var(--color-signal)" }} />}
            tint="rgba(59,130,246,0.12)"
            tintBorder="rgba(59,130,246,0.25)"
            title="View-limited media"
            body="1–5 views per recipient, then it's gone."
          />
          <BrandBullet
            icon={<ShieldOff className="h-4 w-4" style={{ color: "var(--color-alert)" }} />}
            tint="rgba(239,68,68,0.12)"
            tintBorder="rgba(239,68,68,0.25)"
            title="Capture forensics"
            body="Screenshots flagged live, per-viewer watermark on every frame."
          />
          <BrandBullet
            icon={<Lock className="h-4 w-4" style={{ color: "var(--color-online)" }} />}
            tint="rgba(34,197,94,0.12)"
            tintBorder="rgba(34,197,94,0.25)"
            title="No identity baggage"
            body="Username and password only. No phone, no email, no recovery."
          />
        </ul>
      </div>

      {/* Bottom — systems status mono line */}
      <div className="relative z-10 flex items-center gap-2">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--color-online)", boxShadow: "0 0 8px rgba(34,197,94,0.5)" }}
        />
        <span
          className="text-[11px] tracking-[0.04em] text-[var(--color-text-secondary)]"
          style={{ fontFamily: mono }}
        >
          all systems online · v0.1.0
        </span>
      </div>

      {/* Decorative signal arc — bottom right, low opacity */}
      <svg
        width="420"
        height="160"
        viewBox="0 0 420 160"
        fill="none"
        className="pointer-events-none absolute -right-10 bottom-24 opacity-25"
        aria-hidden="true"
      >
        <path d="M10 150 Q210 -40 410 150" stroke="url(#sigGradAuth)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
        <path d="M10 150 Q210 -10 410 150" stroke="url(#sigGradAuth)" strokeWidth="1" strokeLinecap="round" fill="none" opacity="0.6" />
        <path d="M10 150 Q210 30 410 150" stroke="url(#sigGradAuth)" strokeWidth="0.8" strokeLinecap="round" fill="none" opacity="0.35" />
        <defs>
          <linearGradient id="sigGradAuth" x1="0" y1="0" x2="420" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--color-signal)" stopOpacity="0" />
            <stop offset="0.5" stopColor="var(--color-signal)" />
            <stop offset="1" stopColor="var(--color-signal)" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
    </aside>
  );
}

function BrandBullet({
  icon,
  tint,
  tintBorder,
  title,
  body,
}: {
  icon: React.ReactNode;
  tint: string;
  tintBorder: string;
  title: string;
  body: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border"
        style={{ background: tint, borderColor: tintBorder }}
      >
        {icon}
      </div>
      <div className="flex flex-col gap-0.5">
        <p className="text-[14px] font-semibold text-[var(--color-text)]">{title}</p>
        <p className="text-[13px] leading-[18px] text-[var(--color-text-secondary)]">{body}</p>
      </div>
    </li>
  );
}
