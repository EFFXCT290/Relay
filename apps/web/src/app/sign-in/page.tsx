import type { Metadata } from "next";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { AuthForm } from "@/features/auth/components/auth-form";

export const metadata: Metadata = {
  title: "Sign in · Relay",
  description: "Welcome back. Sign in with your username and password.",
};

export default function SignInPage() {
  return (
    <AuthShell
      mode="sign-in"
      title="Welcome back"
      subtitle="Sign in with the username and password you created. There's no other way in — and that's the point."
    >
      <AuthForm mode="sign-in" />
    </AuthShell>
  );
}
