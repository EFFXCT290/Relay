"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, Lock } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { ApiError, api } from "@/frontend-core/api";
import { PasswordMeter } from "./password-meter";

type Mode = "sign-in" | "sign-up";

const MIN_PW = 12;
const USERNAME_RE = /^[A-Za-z0-9_]{3,30}$/;

const mono = "var(--font-mono)";

type Props = { mode: Mode };

export function AuthForm({ mode }: Props) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usernameTouched = username.length > 0;
  const usernameValid = USERNAME_RE.test(username);
  const passwordValid = password.length >= MIN_PW;
  const canSubmit = usernameValid && passwordValid && !submitting;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const path = mode === "sign-up" ? "/api/auth/register" : "/api/auth/login";
      await api<{ userId: string; username: string }>(path, {
        method: "POST",
        body: { username, password },
      });
      router.push("/conversations");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.problem.detail);
      } else {
        setError("Something went wrong. Try again.");
      }
      setSubmitting(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {/* Username field */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <label
            htmlFor="auth-username"
            className="text-xs font-semibold uppercase tracking-[0.04em] text-[var(--color-text-secondary)]"
          >
            Username
          </label>
          <span className="text-[11px] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
            3–30 chars
          </span>
        </div>
        <div className="relative">
          <span
            className="absolute left-4 top-1/2 -translate-y-1/2 text-[16px] text-[var(--color-text-muted)]"
            style={{ fontFamily: mono }}
          >
            @
          </span>
          <Input
            id="auth-username"
            type="text"
            inputMode="text"
            autoComplete={mode === "sign-up" ? "username" : "username"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={30}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            invalid={usernameTouched && !usernameValid}
            style={{ fontFamily: mono, paddingLeft: 30 }}
            placeholder="your-handle"
          />
        </div>
      </div>

      {/* Password field */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <label
            htmlFor="auth-password"
            className="text-xs font-semibold uppercase tracking-[0.04em] text-[var(--color-text-secondary)]"
          >
            Password
          </label>
          <span className="text-[11px] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
            argon2id · 64-byte salt
          </span>
        </div>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-secondary)]" />
          <Input
            id="auth-password"
            type={showPw ? "text" : "password"}
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            invalid={mode === "sign-up" && password.length > 0 && !passwordValid}
            style={{ fontFamily: mono, paddingLeft: 40, paddingRight: 44 }}
            placeholder="••••••••••••"
          />
          <button
            type="button"
            onClick={() => setShowPw((v) => !v)}
            aria-label={showPw ? "Hide password" : "Show password"}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          >
            {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {mode === "sign-up" && <PasswordMeter password={password} />}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border px-4 py-3 text-sm"
          style={{
            background: "rgba(239,68,68,0.08)",
            borderColor: "rgba(239,68,68,0.30)",
            color: "#FCA5A5",
          }}
        >
          {error}
        </div>
      )}

      <Button type="submit" size="lg" disabled={!canSubmit} className="mt-3">
        {submitting
          ? mode === "sign-up"
            ? "Creating account…"
            : "Signing in…"
          : mode === "sign-up"
            ? "Create account"
            : "Sign in"}
        {!submitting && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
