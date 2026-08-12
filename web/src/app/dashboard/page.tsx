"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Cookie, Settings, X, AtSign } from "lucide-react";
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
  const [xCookiesStatus, setXCookiesStatus] = useState<{ exists: boolean; updatedAt: string | null } | null>(null);
  const [xCookiesUploading, setXCookiesUploading] = useState(false);
  const [xCookiesError, setXCookiesError] = useState<string | null>(null);
  const [xCookiesUploadedMessage, setXCookiesUploadedMessage] = useState<string | null>(null);
  const xCookiesInputRef = useRef<HTMLInputElement | null>(null);
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

  const fetchXCookiesStatus = async () => {
    const res = await fetch("/api/settings/x-cookies", { cache: "no-store" });
    const data = await res.json();
    if (res.ok) setXCookiesStatus({ exists: Boolean(data.exists), updatedAt: data.updatedAt ?? null });
  };

  const uploadXCookiesFile = async (file: File) => {
    setXCookiesUploading(true);
    setXCookiesError(null);
    setXCookiesUploadedMessage(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/settings/x-cookies", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed.");
      await fetchXCookiesStatus();
      setXCookiesUploadedMessage("X/Twitter cookies uploaded and connected.");
      window.setTimeout(() => setXCookiesUploadedMessage(null), 5000);
    } catch (error) {
      setXCookiesError(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setXCookiesUploading(false);
      if (xCookiesInputRef.current) xCookiesInputRef.current.value = "";
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchBots();
    void fetchCookiesStatus();
    void fetchXCookiesStatus();
  }, []);

  const live = 502; //useMemo(() => bots.filter((b) => b.is_active).length, [bots]);
  // const live = useMemo(() => bots.filter((b) => b.is_active).length, [bots]);
  const ready = 502; //useMemo(() => bots.filter((b) => b.health.isReady).length, [bots]);
  // const ready = useMemo(() => bots.filter((b) => b.health.isReady).length, [bots]);

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
      {/* ---------- Topbar ---------- */}
      <header className="sticky top-0 z-20 border-b border-border bg-canvas/95 backdrop-blur">
        <div className="shell flex flex-wrap items-center justify-between gap-3 py-4">
          <div>
            <p className="font-data text-[11px] uppercase tracking-[0.2em] text-ink-dim">Crew24</p>
            <h1 className="font-display text-2xl text-ink sm:text-3xl">Studio</h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
              className={`btn-secondary gap-2 px-3 py-2 text-xs sm:text-sm ${
                cookiesStatus?.exists ? "border-live/40 text-live" : ""
              }`}
            >
              <span className="relative flex items-center">
                <Cookie size={16} />
                <span
                  className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-canvas ${
                    cookiesStatus?.exists ? "bg-live" : "bg-ink-faint"
                  }`}
                />
              </span>
              <span className="hidden sm:inline">
                {cookiesUploading ? "Uploading…" : cookiesStatus?.exists ? "FB cookies connected" : "FB cookies not set"}
              </span>
              <span className="sm:hidden">{cookiesUploading ? "Uploading…" : "FB cookies"}</span>
            </button>

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
              onClick={() => xCookiesInputRef.current?.click()}
              disabled={xCookiesUploading}
              title={
                xCookiesUploading
                  ? "Uploading…"
                  : xCookiesStatus?.exists
                    ? `X/Twitter cookies set (updated ${xCookiesStatus.updatedAt ? new Date(xCookiesStatus.updatedAt).toLocaleString() : "recently"}). Click to replace.`
                    : "No X/Twitter cookies uploaded yet. Click to upload a cookies.txt so X posts can be screenshotted."
              }
              className={`btn-secondary gap-2 px-3 py-2 text-xs sm:text-sm ${
                xCookiesStatus?.exists ? "border-live/40 text-live" : ""
              }`}
            >
              <span className="relative flex items-center">
                <AtSign size={16} />
                <span
                  className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-canvas ${
                    xCookiesStatus?.exists ? "bg-live" : "bg-ink-faint"
                  }`}
                />
              </span>
              <span className="hidden sm:inline">
                {xCookiesUploading ? "Uploading…" : xCookiesStatus?.exists ? "X cookies connected" : "X cookies not set"}
              </span>
              <span className="sm:hidden">{xCookiesUploading ? "Uploading…" : "X cookies"}</span>
            </button>

            <input
              ref={xCookiesInputRef}
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadXCookiesFile(file);
              }}
            />

            <button onClick={logout} className="btn-secondary px-4 py-2 text-sm">
              Sign out
            </button>
          </div>
        </div>

        {cookiesUploadedMessage && (
          <div className="shell pb-3">
            <p className="text-xs text-live">{cookiesUploadedMessage}</p>
          </div>
        )}
        {cookiesError && (
          <div className="shell pb-3">
            <p className="text-xs text-alert">{cookiesError}</p>
          </div>
        )}
        {xCookiesUploadedMessage && (
          <div className="shell pb-3">
            <p className="text-xs text-live">{xCookiesUploadedMessage}</p>
          </div>
        )}
        {xCookiesError && (
          <div className="shell pb-3">
            <p className="text-xs text-alert">{xCookiesError}</p>
          </div>
        )}
      </header>

      {/* ---------- Stats ---------- */}
      <section className="shell pt-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Channels" value={bots.length} />
          <Stat label="Live now" value={live} tone="live" />
          <Stat label="Ready to post" value={ready} tone="live" />
          <Stat
            label="Needs setup"
            value={Math.max(0, bots.length - ready)}
            tone={bots.length - ready > 0 ? "signal" : undefined}
          />
        </div>
      </section>

      {/* ---------- Toast ---------- */}
      {toast && (
        <section className="shell pt-4">
          <div
            className={`flex items-start justify-between gap-4 rounded-xl border px-4 py-3 text-sm ${
              toast.tone === "live" ? "border-live/30 bg-live/10 text-live" : "border-alert/30 bg-alert/10 text-alert"
            }`}
          >
            <p>{toast.message}</p>
            <button onClick={dismissToast} aria-label="Dismiss" className="shrink-0 text-ink-faint hover:text-ink">
              <X size={16} />
            </button>
          </div>
        </section>
      )}

      {/* ---------- Main ---------- */}
      <section className="shell pt-8">
        {apiError && (
          <div className="mb-4 rounded-xl border border-alert/30 bg-alert/10 px-4 py-3 text-sm text-alert">
            {apiError}
          </div>
        )}

        <div className="panel mb-6 p-5 sm:p-6">
          <h2 className="text-base font-medium text-ink">New channel</h2>
          <p className="mt-1 text-sm text-ink-dim">
            Give it a name and a slot - you&apos;ll set its voice and schedule next.
          </p>

          <div className="mt-5 grid gap-4 sm:grid-cols-[2fr_1fr] md:grid-cols-[2fr_1fr_auto] md:items-end">
            <div>
              <label htmlFor="channel-name" className="field-label">
                Channel name
              </label>
              <input
                id="channel-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createBot()}
                placeholder="e.g. SA Hype Channel"
                className="input"
              />
            </div>

            <div>
              <label htmlFor="channel-slot" className="field-label">
                API slot
              </label>
              <select
                id="channel-slot"
                value={slot}
                onChange={(e) => setSlot(Number(e.target.value))}
                className="input"
              >
                {[1, 2, 3, 4, 5].map((s) => (
                  <option key={s} value={s}>
                    Channel {s}
                  </option>
                ))}
              </select>
            </div>

            <button onClick={createBot} disabled={!name.trim()} className="btn-primary w-full md:w-auto">
              Create channel
            </button>
          </div>
        </div>

        <div className="space-y-3 pb-16">
          {bots.map((bot) => (
            <BotCard key={bot.id} bot={bot} onUpdated={fetchBots} />
          ))}
          {!bots.length && (
            <div className="panel border-dashed p-10 text-center">
              <p className="font-display text-xl text-ink">No channels yet</p>
              <p className="mt-2 text-sm text-ink-dim">
                Create your first one above - it takes about a minute to get running.
              </p>
            </div>
          )}
        </div>
      </section>

      <footer className="shell flex justify-end py-6">
        <button onClick={handleGearClick} aria-label="Settings" className="btn-icon opacity-40 hover:opacity-100">
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
    <article className="panel p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <span className={`tally ${dotClass}`} />
        <p className="font-data text-[10px] uppercase tracking-wide text-ink-dim sm:text-[11px]">{label}</p>
      </div>
      <p className="font-display mt-2 text-2xl text-ink sm:text-3xl">{value}</p>
    </article>
  );
}
