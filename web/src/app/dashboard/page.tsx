"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Cookie, Settings } from "lucide-react";
import type { BotWithHealth } from "@/types/app";
import { BotCard } from "@/components/dashboard/BotCard";
import { ManualUploadModal } from "@/components/dashboard/ManualUploadModal";

export default function DashboardPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-canvas" />}>
      <DashboardPageInner />
    </Suspense>
  );
}

function DashboardPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [bots, setBots] = useState<BotWithHealth[]>([]);
  const [apiError, setApiError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slot, setSlot] = useState(1);
  const [cookiesStatus, setCookiesStatus] = useState<{ exists: boolean; updatedAt: string | null } | null>(null);
  const [cookiesUploading, setCookiesUploading] = useState(false);
  const [cookiesError, setCookiesError] = useState<string | null>(null);
  const [cookiesUploadedMessage, setCookiesUploadedMessage] = useState<string | null>(null);
  const cookiesInputRef = useRef<HTMLInputElement | null>(null);
  const [manualUploadOpen, setManualUploadOpen] = useState(false);
  const gearClickCountRef = useRef(0);
  const gearClickTimerRef = useRef<number | null>(null);

  const handleGearClick = () => {
    gearClickCountRef.current += 1;
    if (gearClickTimerRef.current) window.clearTimeout(gearClickTimerRef.current);
    if (gearClickCountRef.current >= 3) {
      gearClickCountRef.current = 0;
      setManualUploadOpen(true);
      return;
    }
    gearClickTimerRef.current = window.setTimeout(() => {
      gearClickCountRef.current = 0;
    }, 600);
  };

  const fetchBots = async () => {
    const res = await fetch("/api/bots", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) {
      setApiError(data.error ?? "Couldn't load your channels.");
      return;
    }
    setApiError(null);
    setBots(data.bots ?? []);
  };

  const fetchCookiesStatus = async () => {
    const res = await fetch("/api/settings/facebook-cookies", { cache: "no-store" });
    const data = await res.json();
    if (res.ok) setCookiesStatus({ exists: Boolean(data.exists), updatedAt: data.updatedAt ?? null });
  };

  const uploadCookiesFile = async (file: File) => {
    setCookiesUploading(true);
    setCookiesError(null);
    setCookiesUploadedMessage(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/settings/facebook-cookies", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed.");
      await fetchCookiesStatus();
      setCookiesUploadedMessage("Facebook cookies uploaded and connected.");
      window.setTimeout(() => setCookiesUploadedMessage(null), 5000);
    } catch (error) {
      setCookiesError(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setCookiesUploading(false);
      if (cookiesInputRef.current) cookiesInputRef.current.value = "";
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchBots();
    void fetchCookiesStatus();
  }, []);

  const live = useMemo(() => bots.filter((b) => b.is_active).length, [bots]);
  const ready = useMemo(() => bots.filter((b) => b.health.isReady).length, [bots]);

  const toast = useMemo(() => {
    const connectError = searchParams.get("connectError");
    const connectedBot = searchParams.get("connectedBot");
    const connectedPlatform = searchParams.get("connectedPlatform");
    const zernioSynced = searchParams.get("zernioSynced");

    const platformLabel = connectedPlatform
      ? connectedPlatform.charAt(0).toUpperCase() + connectedPlatform.slice(1)
      : "Account";

    if (zernioSynced === "1") {
      return {
        tone: "live" as const,
        message: connectedBot
          ? `${platformLabel} connected for ${connectedBot}.`
          : `${platformLabel} connected.`,
      };
    }

    if (!connectError) return null;

    const accountNotFoundMatch = connectError.match(/^(instagram|tiktok|facebook)_account_not_found$/);

    const errorMap: Record<string, string> = {
      missing_bot_state: "Connection lost mid-setup. Try connecting again.",
      bot_not_found: "Couldn't find that channel. Try connecting again.",
      sync_failed: "Connected on the platform, but syncing it into the app failed. Try the Sync button next to that platform.",
    };

    const message = accountNotFoundMatch
      ? `Authorized, but no ${accountNotFoundMatch[1]} account showed up yet (e.g. still picking a Facebook Page). Finish that step, then use the Sync button next to that platform instead of reconnecting.`
      : errorMap[connectError] ?? `Connection failed: ${connectError}`;

    return {
      tone: "alert" as const,
      message,
    };
  }, [searchParams]);

  const dismissToast = () => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("connectError");
    next.delete("connectedBot");
    next.delete("connectedPlatform");
    next.delete("zernioSynced");
    const nextUrl = next.toString() ? `${pathname}?${next.toString()}` : pathname;
    router.replace(nextUrl);
  };

  const createBot = async () => {
    if (!name.trim()) return;

    const res = await fetch("/api/bots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, api_slot: slot }),
    });

    const data = await res.json();
    if (!res.ok) {
      setApiError(data.error ?? "Couldn't create that channel.");
      return;
    }

    setName("");
    setApiError(null);
    await fetchBots();
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/signin";
  };

  return (
    <main className="min-h-screen bg-canvas text-ink">
      <header className="sticky top-0 z-20 border-b border-border bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-5 sm:px-6">
          <div>
            <p className="font-data text-[11px] uppercase tracking-[0.2em] text-faded">Only1Marathon</p>
            <h1 className="font-display text-3xl text-ink">Studio</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => cookiesInputRef.current?.click()}
                disabled={cookiesUploading}
                title={
                  cookiesUploading
                    ? "Uploading…"
                    : cookiesStatus?.exists
                      ? `Facebook cookies set (updated ${cookiesStatus.updatedAt ? new Date(cookiesStatus.updatedAt).toLocaleString() : "recently"}). Click to replace.`
                      : "No Facebook cookies uploaded yet. Click to upload a cookies.txt so Facebook video downloads can authenticate."
                }
                className={`relative rounded-full border p-2.5 transition ${
                  cookiesStatus?.exists ? "border-live/40 text-live" : "border-border text-faded hover:text-ink"
                }`}
              >
                <Cookie size={18} />
                <span
                  className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-canvas ${
                    cookiesStatus?.exists ? "bg-live" : "bg-faded/50"
                  }`}
                />
              </button>
              <span className={`font-data text-[11px] ${cookiesStatus?.exists ? "text-live" : "text-faded"}`}>
                {cookiesUploading ? "Uploading…" : cookiesStatus?.exists ? "FB cookies connected" : "FB cookies not set"}
              </span>
            </div>
            <input
              ref={cookiesInputRef}
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadCookiesFile(file);
              }}
            />
            <button
              onClick={logout}
              className="rounded-full border border-border px-4 py-2 text-sm text-faded transition hover:border-signal/40 hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </div>
        {cookiesUploadedMessage && (
          <p className="mx-auto max-w-5xl px-4 pb-3 text-xs text-live sm:px-6">{cookiesUploadedMessage}</p>
        )}
        {cookiesError && <p className="mx-auto max-w-5xl px-4 pb-3 text-xs text-alert sm:px-6">{cookiesError}</p>}
      </header>

      <section className="mx-auto max-w-5xl px-4 pt-8 sm:px-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Channels" value={bots.length} />
          <Stat label="Live now" value={live} tone="live" />
          <Stat label="Ready to post" value={ready} tone="live" />
          <Stat label="Needs setup" value={Math.max(0, bots.length - ready)} tone={bots.length - ready > 0 ? "signal" : undefined} />
        </div>
      </section>

      {toast && (
        <section className="mx-auto max-w-5xl px-4 pt-4 sm:px-6">
          <div
            className={`flex items-start justify-between gap-4 rounded-xl border px-4 py-3 text-sm ${
              toast.tone === "live"
                ? "border-live/30 bg-live/10 text-live"
                : "border-alert/30 bg-alert/10 text-alert"
            }`}
          >
            <p>{toast.message}</p>
            <button onClick={dismissToast} className="text-xs text-faded hover:text-ink">
              Dismiss
            </button>
          </div>
        </section>
      )}

      <section className="mx-auto max-w-5xl px-4 pt-8 sm:px-6">
        {apiError && (
          <div className="mb-4 rounded-xl border border-alert/30 bg-alert/10 px-4 py-3 text-sm text-alert">
            {apiError}
          </div>
        )}

        <div className="mb-6 rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-base font-medium text-ink">New channel</h2>
          <p className="mt-1 text-sm text-faded">Give it a name and a slot — you&apos;ll set its voice and schedule next.</p>
          <div className="mt-4 grid gap-2 md:grid-cols-[2fr_1fr_auto]">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. SA Hype Channel"
              className="rounded-lg border border-border bg-canvas px-3 py-2.5 text-sm text-ink placeholder:text-faded/60 outline-none focus:border-signal/50"
            />
            <select
              value={slot}
              onChange={(e) => setSlot(Number(e.target.value))}
              className="rounded-lg border border-border bg-canvas px-3 py-2.5 text-sm text-ink outline-none focus:border-signal/50"
            >
              {[1, 2, 3, 4, 5].map((s) => (
                <option key={s} value={s}>Channel {s}</option>
              ))}
            </select>
            <button
              onClick={createBot}
              className="rounded-lg bg-signal px-5 py-2.5 text-sm font-medium text-canvas transition hover:brightness-110"
            >
              Create
            </button>
          </div>
        </div>

        <div className="space-y-3 pb-16">
          {bots.map((bot) => (
            <BotCard key={bot.id} bot={bot} onUpdated={fetchBots} />
          ))}
          {!bots.length && (
            <div className="rounded-2xl border border-dashed border-border p-10 text-center">
              <p className="font-display text-xl text-ink">No channels yet</p>
              <p className="mt-2 text-sm text-faded">Create your first one above — it takes about a minute to get running.</p>
            </div>
          )}
        </div>
      </section>

      <footer className="mx-auto flex max-w-5xl justify-end px-4 py-6 sm:px-6">
        <button
          onClick={handleGearClick}
          aria-label="Settings"
          className="rounded-full p-2 text-faded/40 transition hover:text-faded"
        >
          <Settings size={14} />
        </button>
      </footer>

      {manualUploadOpen && <ManualUploadModal bots={bots} onClose={() => setManualUploadOpen(false)} />}
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "live" | "signal" }) {
  const dotClass = tone === "live" ? "tally-live" : tone === "signal" ? "tally-signal" : "tally-off";
  return (
    <article className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <span className={`tally ${dotClass}`} />
        <p className="font-data text-[11px] uppercase tracking-wide text-faded">{label}</p>
      </div>
      <p className="font-display mt-2 text-3xl text-ink">{value}</p>
    </article>
  );
}