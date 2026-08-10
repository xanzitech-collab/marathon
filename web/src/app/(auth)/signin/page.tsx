import { AuthForm } from "@/components/auth/AuthForm";
import { Suspense } from "react";

export default function SignInPage() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas p-6">
      <div className="relative z-10 w-full max-w-md">
        <Suspense fallback={<div className="rounded-2xl border border-border bg-surface p-6 text-sm text-ink-dim">Loading sign in...</div>}>
          <AuthForm />
        </Suspense>
      </div>
    </main>
  );
}
