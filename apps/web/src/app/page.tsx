import Link from "next/link";
import { ArrowRight, FileText, Shield, ShieldOff, Lock, Eye } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Wordmark } from "@/shared/components/wordmark";
import { LandingHeader } from "@/shared/components/landing-header";

const display = "var(--font-display)";
const mono = "var(--font-mono)";

export default function LandingPage() {
  return (
    <>
      <LandingHeader />
      <main className="relative mx-auto flex w-full max-w-[640px] flex-col px-0 lg:max-w-[1120px] lg:px-8">
      {/* Hero */}
      <section className="px-6 pt-10 lg:px-0 lg:pt-12">
        <Link
          href="/docs/changelog"
          className="group inline-flex items-center gap-2 self-start rounded-full border px-3 py-1.5 transition-colors hover:border-[var(--color-hairline-strong)]"
          style={{ borderColor: "var(--color-hairline)", background: "var(--color-panel)" }}
        >
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-white"
            style={{ background: "var(--color-signal)", fontFamily: mono }}
          >
            v0.1
          </span>
          <span className="text-[12px] text-[var(--color-text-secondary)]">
            Private preview · read what's new
          </span>
          <ArrowRight className="h-3 w-3 text-[var(--color-text-muted)] transition-transform group-hover:translate-x-0.5" />
        </Link>

        <div className="mt-6 flex items-center gap-2.5">
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

        <h1
          className="mt-5 text-[52px] font-extrabold leading-[54px] tracking-[-0.03em] text-[var(--color-text)] lg:text-[88px] lg:leading-[88px]"
          style={{ fontFamily: display }}
        >
          A secure way
          <br />
          to message<span style={{ color: "var(--color-signal)" }}>.</span>
        </h1>

        <p className="mt-5 max-w-[320px] text-base leading-6 text-[var(--color-text-secondary)] lg:max-w-[520px] lg:text-lg lg:leading-7">
          Direct messages with view limits, capture forensics, and a 30-second media window.
          Built for things meant to be temporary.
        </p>

        <div className="mt-8 flex flex-col gap-3 lg:max-w-[480px] lg:flex-row">
          <Button asChild size="lg" className="lg:flex-1">
            <Link href="/sign-up">
              Create your account
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="secondary" size="lg" className="lg:flex-1">
            <Link href="/sign-in">I already have an account</Link>
          </Button>
        </div>

        <div className="mt-4 flex items-center justify-center gap-2 lg:justify-start">
          <Shield className="h-3 w-3 text-[var(--color-text-muted)]" />
          <span
            className="text-[11px] tracking-[0.04em] text-[var(--color-text-muted)]"
            style={{ fontFamily: mono }}
          >
            no phone · no email · username only
          </span>
        </div>
      </section>

      {/* Live product preview */}
      <PreviewWindow />

      {/* Features section */}
      <section className="px-6 pt-20 lg:px-0 lg:pt-32">
        <div className="flex items-center gap-2.5 pb-4">
          <span className="block h-px w-6 bg-white/20" />
          <span
            className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--color-text-secondary)]"
            style={{ fontFamily: mono }}
          >
            The stack
          </span>
        </div>
        <h2
          className="max-w-[320px] text-[36px] font-extrabold leading-[40px] tracking-[-0.025em] text-[var(--color-text)] lg:max-w-[640px] lg:text-[56px] lg:leading-[60px]"
          style={{ fontFamily: display }}
        >
          Engineered for messages that aren't meant to last.
        </h2>

        <div className="mt-10 flex flex-col gap-4 lg:grid lg:grid-cols-3 lg:gap-6">
          <PillarCard
            accent="signal"
            icon={<Eye className="h-5 w-5" style={{ color: "var(--color-signal)" }} />}
            badge={
              <div className="flex items-baseline gap-1">
                <span
                  className="text-[40px] font-extrabold leading-none tracking-[-0.03em] text-[var(--color-text)]"
                  style={{ fontFamily: display }}
                >
                  1–5
                </span>
                <span className="text-[11px] tracking-[0.04em] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
                  views
                </span>
              </div>
            }
            title="View-limited media"
            body="Set a per-recipient view count. Once they've watched it, it's gone — even from your conversation."
          />
          <PillarCard
            accent="alert"
            icon={<ShieldOff className="h-5 w-5" style={{ color: "var(--color-alert)" }} />}
            badge={
              <div
                className="flex items-center gap-1.5 rounded-full border px-2.5 py-1"
                style={{
                  background: "rgba(239,68,68,0.10)",
                  borderColor: "rgba(239,68,68,0.30)",
                }}
              >
                <span
                  className="relay-pulse block h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--color-alert)" }}
                />
                <span
                  className="text-[10px] font-semibold uppercase tracking-[0.06em]"
                  style={{ color: "#FCA5A5", fontFamily: mono }}
                >
                  Live alert
                </span>
              </div>
            }
            title="Capture forensics"
            body="Screenshot and record attempts are flagged in real-time. Per-viewer watermarks make any leak traceable."
          />
          <PillarCard
            accent="online"
            icon={<Lock className="h-5 w-5" style={{ color: "var(--color-online)" }} />}
            badge={
              <div className="flex flex-col items-end gap-0.5">
                <span className="text-[11px] tracking-[0.04em] text-[var(--color-text-secondary)]" style={{ fontFamily: mono }}>
                  argon2id · sha-256
                </span>
                <span className="text-[11px] tracking-[0.04em] text-[var(--color-text-secondary)]" style={{ fontFamily: mono }}>
                  256-bit per-user salt
                </span>
              </div>
            }
            title="No identity baggage"
            body="Username and password only. HTTPOnly cookies, JWT-rotated sessions, no PII on the wire."
          />
        </div>
      </section>

      {/* Closing CTA */}
      <section className="relative flex flex-col items-center gap-6 px-6 pt-24 lg:px-0 lg:pt-40">
        <svg
          width="220"
          height="80"
          viewBox="0 0 200 80"
          fill="none"
          className="absolute left-1/2 top-14 -translate-x-1/2 opacity-35 lg:top-28"
          aria-hidden="true"
        >
          <path d="M10 70 Q100 -10 190 70" stroke="url(#sigGrad)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          <path d="M10 70 Q100 10 190 70" stroke="url(#sigGrad)" strokeWidth="1" strokeLinecap="round" fill="none" opacity="0.6" />
          <path d="M10 70 Q100 30 190 70" stroke="url(#sigGrad)" strokeWidth="0.8" strokeLinecap="round" fill="none" opacity="0.35" />
          <defs>
            <linearGradient id="sigGrad" x1="0" y1="0" x2="200" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="var(--color-signal)" stopOpacity="0" />
              <stop offset="0.5" stopColor="var(--color-signal)" />
              <stop offset="1" stopColor="var(--color-signal)" stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>

        <h3
          className="relative max-w-[280px] text-center text-[28px] font-extrabold leading-8 tracking-[-0.025em] text-[var(--color-text)] lg:max-w-[640px] lg:text-[44px] lg:leading-[48px]"
          style={{ fontFamily: display }}
        >
          Start sending things meant to disappear.
        </h3>

        <div className="flex w-full flex-col gap-2.5 pt-2 lg:max-w-[420px]">
          <Button asChild size="lg">
            <Link href="/sign-up">
              Get Relay
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="ghost" size="md" className="text-[var(--color-text-secondary)]">
            <Link href="/docs/api">
              <FileText className="h-3.5 w-3.5" />
              Read the API documentation
            </Link>
          </Button>
        </div>
      </section>

      <Footer />
      </main>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
//  Sub-sections
// ──────────────────────────────────────────────────────────────────────────

function PreviewWindow() {
  return (
    <section className="mx-6 mt-12 overflow-hidden rounded-3xl border bg-[var(--color-panel)] shadow-[0_24px_60px_rgba(0,0,0,0.55)] transition-shadow hover:shadow-[0_32px_72px_rgba(59,130,246,0.18),0_24px_60px_rgba(0,0,0,0.55)] lg:mx-0 lg:mt-20"
      style={{ borderColor: "var(--color-hairline)" }}
    >
      {/* Chat chrome */}
      <div className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: "var(--color-hairline)" }}
      >
        <div className="flex items-center gap-2">
          <Avatar initial="M" />
          <div className="flex flex-col">
            <span className="text-[13px] font-semibold leading-4 text-[var(--color-text)]">@mira</span>
            <div className="flex items-center gap-1.5">
              <span className="h-1 w-1 rounded-full bg-[var(--color-online)]" />
              <span className="text-[10px] text-[var(--color-text-secondary)]" style={{ fontFamily: mono }}>
                online
              </span>
            </div>
          </div>
        </div>
        <span
          className="text-[10px] tracking-[0.04em] text-[var(--color-text-muted)]"
          style={{ fontFamily: mono }}
        >
          END-TO-END
        </span>
      </div>

      {/* Thread */}
      <div className="flex flex-col gap-3 p-4">
        {/* Received bubble */}
        <div className="max-w-[240px] self-start rounded-[20px_20px_20px_6px] border bg-[var(--color-raised)] px-3.5 py-2.5"
          style={{ borderColor: "rgba(255,255,255,0.04)" }}
        >
          <p className="text-sm leading-5 text-[var(--color-text)]">
            photos from last night — only seeing these once 👀
          </p>
        </div>

        {/* Sent ephemeral media bubble */}
        <div className="flex flex-col items-end gap-1 self-end">
          <div className="relative w-[200px] overflow-hidden rounded-[22px_22px_6px_22px] border bg-[var(--color-raised)]"
            style={{ borderColor: "rgba(255,255,255,0.06)" }}
          >
            <div className="flex h-[180px] items-center justify-center bg-[linear-gradient(135deg,#1E293B_0%,#0F172A_60%,#020617_100%)]">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                <circle cx="24" cy="24" r="22" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />
                <circle
                  cx="24"
                  cy="24"
                  r="22"
                  stroke="var(--color-signal)"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeDasharray="92 46"
                  transform="rotate(-90 24 24)"
                />
                <path d="M20 16v16l13-8z" fill="#fff" />
              </svg>
              <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-full border bg-black/45 px-2 py-1 backdrop-blur-md"
                style={{ borderColor: "rgba(255,255,255,0.08)" }}
              >
                <span className="h-1 w-1 rounded-full bg-[var(--color-signal)]" />
                <span className="text-[10px] tracking-[0.04em] text-[var(--color-text)]" style={{ fontFamily: mono }}>
                  2 of 3 left
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 pr-1">
            <ReadDoubleCheck />
            <span className="text-[10px] tracking-[0.02em] text-[var(--color-read-receipt)]" style={{ fontFamily: mono }}>
              Read 9:42
            </span>
          </div>
        </div>

        {/* Typing dots */}
        <div className="flex items-center gap-1.5 self-start rounded-[20px_20px_20px_6px] border bg-[var(--color-raised)] px-4 py-3"
          style={{ borderColor: "rgba(255,255,255,0.04)" }}
        >
          <span className="relay-typing-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-signal)" }} />
          <span className="relay-typing-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-signal)" }} />
          <span className="relay-typing-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-signal)" }} />
        </div>
      </div>
    </section>
  );
}

function PillarCard({
  icon,
  badge,
  title,
  body,
}: {
  accent: "signal" | "alert" | "online";
  icon: React.ReactNode;
  badge: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <article className="group relative flex flex-col gap-4 overflow-hidden rounded-3xl border bg-[var(--color-panel)] p-6 transition-all hover:-translate-y-0.5 hover:border-[var(--color-hairline-strong)] hover:bg-[var(--color-raised)] hover:shadow-[0_12px_36px_rgba(0,0,0,0.35)]"
      style={{ borderColor: "var(--color-hairline)" }}
    >
      <div className="flex items-end justify-between">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border transition-colors group-hover:border-[var(--color-hairline-strong)]"
          style={{
            background: "rgba(255,255,255,0.02)",
            borderColor: "var(--color-hairline)",
          }}
        >
          {icon}
        </div>
        {badge}
      </div>
      <div className="flex flex-col gap-1.5">
        <h3
          className="text-lg font-bold tracking-[-0.015em] text-[var(--color-text)]"
          style={{ fontFamily: display }}
        >
          {title}
        </h3>
        <p className="text-sm leading-5 text-[var(--color-text-secondary)]">{body}</p>
      </div>
    </article>
  );
}

function Footer() {
  return (
    <footer className="flex flex-col gap-6 px-6 pt-20 pb-10 lg:px-0">
      <div className="h-px w-full" style={{ background: "var(--color-hairline)" }} />
      <Wordmark size={18} />
      <nav className="flex flex-wrap gap-[18px]">
        {["Privacy", "Terms", "Security", "Status", "GitHub"].map((label) => (
          <Link
            key={label}
            href="#"
            className="text-[13px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          >
            {label}
          </Link>
        ))}
      </nav>
      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px] tracking-[0.04em] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
          v0.1.0 · build a4a3d
        </span>
        <div className="flex items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--color-online)", boxShadow: "0 0 8px rgba(34,197,94,0.5)" }}
          />
          <span
            className="text-[11px] tracking-[0.04em] text-[var(--color-text-secondary)]"
            style={{ fontFamily: mono }}
          >
            all systems online
          </span>
        </div>
      </div>
    </footer>
  );
}

function Avatar({ initial }: { initial: string }) {
  return (
    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[linear-gradient(135deg,#3B82F6_0%,#1D4ED8_100%)]">
      <span
        className="text-[11px] font-bold text-white"
        style={{ fontFamily: "var(--font-body)" }}
      >
        {initial}
      </span>
    </div>
  );
}

function ReadDoubleCheck() {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
      <path
        d="M1.5 7.5l3.5 3.5L12.5 3.5"
        stroke="var(--color-read-receipt)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M1.5 7.5l3.5 3.5L12.5 3.5"
        stroke="var(--color-read-receipt)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(-4 0)"
      />
    </svg>
  );
}
