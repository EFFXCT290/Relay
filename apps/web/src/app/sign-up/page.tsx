import type { Metadata } from "next";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { AuthForm } from "@/features/auth/components/auth-form";

export const metadata: Metadata = {
  title: "Create your account · Relay",
  description: "Username and 12-character password. No phone, no email, no recovery.",
};

export default function SignUpPage() {
  return (
    <AuthShell
      mode="sign-up"
      title="Create your account"
      subtitle="A username and a 12-character password is all we need. No phone, no email, no recovery — by design."
    >
      <AuthForm mode="sign-up" />
    </AuthShell>
  );
}
