"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        throw new Error(json.error ?? "Authentication failed");
      }

      const nextPath = searchParams.get("next");
      if (nextPath && nextPath.startsWith("/")) {
        router.push(nextPath);
      } else {
        router.push("/dashboard");
      }
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-surface p-6">
      <h1 className="font-display text-2xl text-ink">Sign in</h1>
      <p className="text-sm text-ink-dim">Crew24 Bot Control Center</p>

      <div>
        <label className="mb-1 block text-sm text-ink-dim">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          type="text"
          required
          className="input"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm text-ink-dim">Password</label>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          minLength={6}
          required
          className="input"
        />
      </div>

      <button type="submit" disabled={loading} className="btn-primary w-full">
        {loading ? "Please wait..." : "Sign in"}
      </button>

      {message && <p className="text-sm text-alert">{message}</p>}
    </form>
  );
}
