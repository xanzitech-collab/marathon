"use client";

import { useEffect, useMemo, useState } from "react";
import { X, ChevronDown, ChevronRight, Music, Trash2, Radio, CheckCircle2, Video, Image as ImageIcon } from "lucide-react";
import type { BotWithHealth, ConnectablePlatform, Song } from "@/types/app";
import { safeFetchJson } from "@/lib/safe-fetch";

interface CategorySummary {
  category: string;
  total: number;
  images: number;
  videos: number;
  unposted: number;
}

interface VaultItem {
  id: string;
  category: string;
  source: string;
  mediaType: "image" | "video";
  originalFilename: string;
  contextText: string | null;
  isPosted: boolean;
  previewUrl: string | null;
}

interface LiveItem {
  url: string;
  title: string;
  description: string;
  tags: string[];
  source: string;
}

type Platform = "tiktok" | "facebook" | "youtube";

interface SelectedEntry {
  kind: "vault" | "live";
  key: string;
  title: string;
  previewUrl: string | null;
  mediaType: "image" | "video";
  caption: string;
  tags: string;
  songId: string | null;
  noSong: boolean;
  captionLoading: boolean;
  vaultItemId?: string;
  mediaAssetId?: string;
  sourceUrl?: string;
  sourceLabel?: string;
  resolveError?: string;
  platforms: ConnectablePlatform[];
}

interface ManualUploadModalProps {
  bots: BotWithHealth[];
  onClose: () => void;
}

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "tiktok", label: "TikTok" },
  { id: "facebook", label: "Facebook" },
  { id: "youtube", label: "YouTube" },
];

const PUBLISH_PLATFORMS: ConnectablePlatform[] = ["instagram", "tiktok", "facebook"];
const PUBLISH_PLATFORM_LABELS: Record<ConnectablePlatform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  facebook: "Facebook",
};

function extractSourceAccountHandle(url: string): string | null {
  const tiktokMatch = url.match(/tiktok\.com\/@([\w.-]+)/i);
  if (tiktokMatch) return tiktokMatch[1];
  const facebookMatch = url.match(/facebook\.com\/([\w.-]+)\//i);
  if (facebookMatch) return facebookMatch[1];
  return null;
}

function isRateLimitActive(rateLimitedUntil: string | null | undefined): boolean {
  return Boolean(rateLimitedUntil) && new Date(rateLimitedUntil as string).getTime() > Date.now();
}

function formatTimeRemaining(untilIso: string): string {
  const msRemaining = new Date(untilIso).getTime() - Date.now();
  if (msRemaining <= 0) return "less than a minute";
  const totalMinutes = Math.ceil(msRemaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function ManualUploadModal({ bots, onClose }: ManualUploadModalProps) {
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [tab, setTab] = useState<"vault" | "live">("vault");

  // Vault tab state
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [itemsByCategory, setItemsByCategory] = useState<Record<string, VaultItem[]>>({});
  const [loadingCategory, setLoadingCategory] = useState<string | null>(null);

  // Live tab state
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [liveItems, setLiveItems] = useState<LiveItem[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const [selected, setSelected] = useState<Map<string, SelectedEntry>>(new Map());
  const [songs, setSongs] = useState<Song[]>([]);
  const [songPickerFor, setSongPickerFor] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishProgress, setPublishProgress] = useState<{ done: number; total: number } | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Keyed by entry key, tracked separately from `selected` so successfully
  // published items can stay visible with a checkmark instead of vanishing
  // the instant they're done — the list only used to get wiped entirely.
  const [publishResults, setPublishResults] = useState<Map<string, { status: "success" | "error"; message?: string }>>(
    new Map(),
  );

  const connectedPlatforms = bots.find((b) => b.id === botId)?.health.connectedPlatforms ?? [];
  // A platform can be "connected" but still temporarily rate-limited (e.g.
  // TikTok's own posting-frequency cooldown) — selecting it would silently
  // get it filtered out of the publish request with no visible error, so
  // surface that state on the chip itself instead.
  const rateLimitedUntilByPlatform = useMemo(() => {
    return new Map(
      (bots.find((b) => b.id === botId)?.platformAccounts ?? [])
        .filter((account) => isRateLimitActive(account.rate_limited_until))
        .map((account) => [account.platform, account.rate_limited_until as string]),
    );
  }, [bots, botId]);

  const { liveGroups, liveUngrouped } = useMemo(() => {
    const byHandle = new Map<string, LiveItem[]>();
    const noHandle: LiveItem[] = [];
    for (const item of liveItems) {
      const handle = extractSourceAccountHandle(item.url);
      if (!handle) {
        noHandle.push(item);
        continue;
      }
      const list = byHandle.get(handle) ?? [];
      list.push(item);
      byHandle.set(handle, list);
    }
    const groups: Array<{ handle: string; items: LiveItem[] }> = [];
    const ungrouped: LiveItem[] = [...noHandle];
    for (const [handle, items] of byHandle) {
      if (items.length > 2) groups.push({ handle, items });
      else ungrouped.push(...items);
    }
    return { liveGroups: groups, liveUngrouped: ungrouped };
  }, [liveItems]);

  const toggleGroupCollapsed = (handle: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });
  };

  useEffect(() => {
    void (async () => {
      const result = await safeFetchJson<{ categories?: CategorySummary[]; error?: string }>("/api/meme-vault/categories");
      if (result.ok) setCategories(result.data?.categories ?? []);
      else setError(result.error || "Couldn't load meme vault categories.");
    })();
  }, []);

  useEffect(() => {
    if (!botId) return;
    void (async () => {
      const result = await safeFetchJson<{ songs?: Song[]; error?: string }>(`/api/bots/${botId}/songs`);
      if (result.ok) setSongs(result.data?.songs ?? []);
    })();
  }, [botId]);

  const loadLivePlatform = async (nextPlatform: Platform) => {
    setPlatform(nextPlatform);
    setLiveItems([]);
    setLiveError(null);
    setLiveLoading(true);

    try {
      const response = await fetch(`/api/live-discovery?platform=${nextPlatform}`);
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => null);
        setLiveError(data?.error || "Couldn't load live content for this platform.");
        return;
      }

      // Streamed as newline-delimited JSON — each line is a small batch that
      // gets appended to the list as soon as it arrives, instead of waiting
      // for the whole crawl to finish before showing anything.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");
          if (!line) continue;

          try {
            const payload = JSON.parse(line) as { items?: LiveItem[]; error?: string; done?: boolean };
            if (payload.items?.length) {
              setLiveItems((prev) => [...prev, ...payload.items!]);
            }
            if (payload.error) setLiveError(payload.error);
          } catch {
            // A partial/corrupt line just gets skipped — the rest of the stream still comes through.
          }
        }
      }
    } catch (error) {
      setLiveError(error instanceof Error ? error.message : "Couldn't load live content for this platform.");
    } finally {
      setLiveLoading(false);
    }
  };

  const openLiveTab = () => {
    setTab("live");
    if (liveItems.length === 0 && !liveLoading && !liveError) {
      void loadLivePlatform(platform);
    }
  };

  const toggleCategory = async (category: string) => {
    const next = new Set(expanded);
    if (next.has(category)) {
      next.delete(category);
      setExpanded(next);
      return;
    }
    next.add(category);
    setExpanded(next);
    if (!itemsByCategory[category]) {
      setLoadingCategory(category);
      const result = await safeFetchJson<{ items?: VaultItem[]; error?: string }>(
        `/api/meme-vault/items?category=${encodeURIComponent(category)}`,
      );
      setLoadingCategory(null);
      if (result.ok) {
        setItemsByCategory((prev) => ({ ...prev, [category]: result.data?.items ?? [] }));
      } else {
        setError(result.error || "Couldn't load that category.");
      }
    }
  };

  const toggleSelectVault = async (item: VaultItem) => {
    const key = `vault:${item.id}`;
    const next = new Map(selected);
    if (next.has(key)) {
      next.delete(key);
      setSelected(next);
      return;
    }
    next.set(key, {
      kind: "vault",
      key,
      title: item.originalFilename,
      previewUrl: item.previewUrl,
      mediaType: item.mediaType,
      caption: "",
      tags: "",
      songId: null,
      noSong: true,
      captionLoading: true,
      vaultItemId: item.id,
      platforms: connectedPlatforms,
    });
    setSelected(next);

    if (!botId) return;
    const result = await safeFetchJson<{ caption?: string; tags?: string[]; error?: string }>(
      `/api/bots/${botId}/meme-vault-caption`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vaultItemId: item.id }),
      },
    );
    setSelected((prev) => {
      const updated = new Map(prev);
      const existing = updated.get(key);
      if (!existing) return prev;
      updated.set(key, {
        ...existing,
        caption: result.ok ? result.data?.caption ?? "" : "",
        tags: result.ok ? (result.data?.tags ?? []).join(", ") : "",
        captionLoading: false,
      });
      return updated;
    });
  };

  const toggleSelectLive = async (item: LiveItem) => {
    const key = `live:${item.url}`;
    const next = new Map(selected);
    if (next.has(key)) {
      next.delete(key);
      setSelected(next);
      return;
    }
    next.set(key, {
      kind: "live",
      key,
      title: item.title,
      previewUrl: null,
      mediaType: "video",
      caption: "",
      tags: item.tags.join(", "),
      songId: null,
      noSong: true,
      captionLoading: true,
      sourceUrl: item.url,
      sourceLabel: item.source,
      platforms: connectedPlatforms,
    });
    setSelected(next);

    if (!botId) return;
    const result = await safeFetchJson<{
      mediaAssetId?: string;
      previewUrl?: string;
      mediaType?: "image" | "video";
      caption?: string;
      tags?: string[];
      error?: string;
    }>(`/api/bots/${botId}/live-resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: item.url, title: item.title, description: item.description, tags: item.tags }),
    });
    setSelected((prev) => {
      const updated = new Map(prev);
      const existing = updated.get(key);
      if (!existing) return prev;
      if (!result.ok) {
        updated.set(key, { ...existing, captionLoading: false, resolveError: result.error || "Could not resolve this video." });
        return updated;
      }
      updated.set(key, {
        ...existing,
        captionLoading: false,
        mediaAssetId: result.data?.mediaAssetId,
        previewUrl: result.data?.previewUrl ?? null,
        mediaType: result.data?.mediaType ?? "video",
        caption: result.data?.caption ?? "",
        tags: (result.data?.tags ?? item.tags).join(", "),
      });
      return updated;
    });
  };

  const updateSelected = (key: string, patch: Partial<SelectedEntry>) => {
    setSelected((prev) => {
      const updated = new Map(prev);
      const existing = updated.get(key);
      if (!existing) return prev;
      updated.set(key, { ...existing, ...patch });
      return updated;
    });
  };

  const togglePlatformForEntry = (key: string, targetPlatform: ConnectablePlatform) => {
    setSelected((prev) => {
      const updated = new Map(prev);
      const existing = updated.get(key);
      if (!existing) return prev;
      const has = existing.platforms.includes(targetPlatform);
      const platforms = has ? existing.platforms.filter((p) => p !== targetPlatform) : [...existing.platforms, targetPlatform];
      updated.set(key, { ...existing, platforms });
      return updated;
    });
  };

  const removeSelected = (key: string) => {
    const next = new Map(selected);
    next.delete(key);
    setSelected(next);
  };

  const publishAll = async () => {
    if (!botId || selected.size === 0) return;
    setPublishing(true);
    setResultMessage(null);
    setError(null);

    const entries = Array.from(selected.values()).filter((e) => publishResults.get(e.key)?.status !== "success");
    const vaultJobs = entries
      .filter((e) => e.kind === "vault" && e.vaultItemId && e.platforms.length > 0)
      .map((e) => ({
        key: e.key,
        endpoint: `/api/bots/${botId}/manual-publish`,
        items: [
          {
            vaultItemId: e.vaultItemId,
            caption: e.caption,
            tags: e.tags.split(",").map((t) => t.trim()).filter(Boolean),
            songId: e.songId,
            noSong: e.noSong,
            platforms: e.platforms,
          },
        ],
      }));
    const liveJobs = entries
      .filter((e) => e.kind === "live" && e.mediaAssetId && !e.resolveError && e.platforms.length > 0)
      .map((e) => ({
        key: e.key,
        endpoint: `/api/bots/${botId}/live-publish`,
        items: [
          {
            mediaAssetId: e.mediaAssetId,
            mediaType: e.mediaType,
            caption: e.caption,
            tags: e.tags.split(",").map((t) => t.trim()).filter(Boolean),
            songId: e.songId,
            noSong: e.noSong,
            sourceUrl: e.sourceUrl,
            sourceLabel: e.sourceLabel,
            discoveryTitle: e.title,
            discoveryDescription: e.title,
            platforms: e.platforms,
          },
        ],
      }));

    // Published one item per request instead of one batched call so the
    // button can show live progress (N/total) as each one finishes, instead
    // of a single opaque "Publishing…" until the whole batch completes.
    const jobs = [...vaultJobs, ...liveJobs];
    const total = jobs.length;
    setPublishProgress({ done: 0, total });

    let publishedCount = 0;
    const errors: string[] = [];
    const results = new Map<string, { status: "success" | "error"; message?: string }>();

    for (const job of jobs) {
      try {
        // Each job sends exactly one item, so results[0] is that item's real
        // outcome. A 200 response here just means the request was handled —
        // the item itself can still have failed/been queued for later (e.g.
        // rate-limited), which result.ok alone can't tell apart from success.
        const result = await safeFetchJson<{
          results?: Array<{ published: boolean; error?: string }>;
          publishedCount?: number;
          error?: string;
        }>(job.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: job.items }),
        });
        const itemResult = result.data?.results?.[0];
        if (result.ok && itemResult?.published) {
          publishedCount += 1;
          results.set(job.key, { status: "success" });
        } else {
          const message = itemResult?.error || result.error || "Publish failed.";
          errors.push(message);
          results.set(job.key, { status: "error", message });
        }
      } catch (jobError) {
        const message = jobError instanceof Error ? jobError.message : "Publish failed.";
        errors.push(message);
        results.set(job.key, { status: "error", message });
      }
      setPublishProgress((prev) => (prev ? { done: prev.done + 1, total: prev.total } : prev));
    }

    setResultMessage(`Published ${publishedCount} of ${total}.`);
    if (errors.length > 0) setError(errors.slice(0, 3).join(" | "));
    setPublishResults((prev) => new Map([...prev, ...results]));
    setPublishing(false);
    setPublishProgress(null);
  };

  const selectedList = Array.from(selected.values());
  const publishableCount = selectedList.filter(
    (e) =>
      publishResults.get(e.key)?.status !== "success" &&
      (e.kind === "vault" || (e.mediaAssetId && !e.resolveError)) &&
      e.platforms.length > 0,
  ).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 sm:p-4">
      <div className="flex h-full w-full flex-col rounded-none border-0 border-border-strong bg-surface-raised sm:h-[90vh] sm:max-w-5xl sm:rounded-2xl sm:border">
        <div className="flex items-center justify-between border-b border-border px-4 py-4 sm:px-5">
          <div>
            <h2 className="font-display text-xl text-ink">Manual upload</h2>
            <p className="text-xs text-ink-dim">Hand-pick content and publish it directly.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="btn-icon">
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
          <span className="text-xs text-ink-dim">Publish to</span>
          <select value={botId} onChange={(e) => setBotId(e.target.value)} className="input min-w-0 flex-1 sm:max-w-xs sm:flex-none">
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>

          <div className="flex gap-1 rounded-lg border border-border p-1 sm:ml-auto">
            <button
              onClick={() => setTab("vault")}
              className={`rounded-md px-3 py-1 text-xs ${tab === "vault" ? "bg-signal text-canvas" : "text-ink-dim"}`}
            >
              Vault
            </button>
            <button
              onClick={openLiveTab}
              className={`flex items-center gap-1 rounded-md px-3 py-1 text-xs ${tab === "live" ? "bg-signal text-canvas" : "text-ink-dim"}`}
            >
              <Radio size={12} /> Live
            </button>
          </div>
        </div>

        {error && <p className="px-4 pt-3 text-xs text-alert sm:px-5">{error}</p>}
        {resultMessage && <p className="px-4 pt-3 text-xs text-live sm:px-5">{resultMessage}</p>}

        <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
          <div className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-4">
            {tab === "vault" && (
              <>
                {categories.map((cat) => (
                  <div key={cat.category} className="mb-2 rounded-lg border border-border">
                    <button
                      onClick={() => void toggleCategory(cat.category)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-ink"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {expanded.has(cat.category) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span className="truncate">{cat.category}</span>
                      </span>
                      <span className="shrink-0 font-data text-[11px] text-ink-dim">
                        {cat.images} img · {cat.videos} vid
                      </span>
                    </button>
                    {expanded.has(cat.category) && (
                      <div className="grid grid-cols-3 gap-2 border-t border-border p-3 md:grid-cols-4">
                        {loadingCategory === cat.category && <p className="col-span-full text-xs text-ink-dim">Loading…</p>}
                        {(itemsByCategory[cat.category] ?? []).map((item) => {
                          const isSelected = selected.has(`vault:${item.id}`);
                          return (
                            <button
                              key={item.id}
                              onClick={() => void toggleSelectVault(item)}
                              className={`relative overflow-hidden rounded-lg border text-left ${
                                isSelected ? "border-signal ring-2 ring-signal/50" : "border-border"
                              }`}
                            >
                              {item.mediaType === "video" ? (
                                <video src={item.previewUrl ?? undefined} muted className="h-24 w-full object-cover" />
                              ) : (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={item.previewUrl ?? undefined} alt={item.originalFilename} className="h-24 w-full object-cover" />
                              )}
                              <span
                                className="absolute left-1 top-1 flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] text-white"
                                title={item.mediaType === "video" ? "Video" : "Image"}
                              >
                                {item.mediaType === "video" ? <Video size={11} /> : <ImageIcon size={11} />}
                              </span>
                              {isSelected && (
                                <span className="absolute right-1 top-1 rounded-full bg-signal px-1.5 py-0.5 text-[10px] text-canvas">✓</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
                {categories.length === 0 && !error && <p className="text-sm text-ink-dim">Loading categories…</p>}
              </>
            )}

            {tab === "live" && (
              <>
                <div className="mb-3 flex flex-wrap gap-2">
                  {PLATFORMS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => void loadLivePlatform(p.id)}
                      className={`rounded-full border px-3 py-1 text-xs ${
                        platform === p.id ? "border-signal bg-signal/10 text-signal" : "border-border text-ink-dim"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                {liveLoading && <p className="text-sm text-ink-dim">Searching {platform}…</p>}
                {liveError && <p className="text-xs text-alert">{liveError}</p>}
                {!liveLoading && !liveError && liveItems.length === 0 && (
                  <p className="text-sm text-ink-dim">No recent {platform} content found. Try another platform.</p>
                )}
                <div className="space-y-2">
                  {liveGroups.map((group) => {
                    const isCollapsed = collapsedGroups.has(group.handle);
                    return (
                      <div key={group.handle} className="rounded-lg border border-border">
                        <button
                          onClick={() => toggleGroupCollapsed(group.handle)}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-ink"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            <span className="truncate">@{group.handle}</span>
                          </span>
                          <span className="shrink-0 font-data text-[11px] text-ink-dim">{group.items.length} videos</span>
                        </button>
                        {!isCollapsed && (
                          <div className="space-y-2 border-t border-border p-2">
                            {group.items.map((item) => (
                              <LiveItemButton
                                key={item.url}
                                item={item}
                                isSelected={selected.has(`live:${item.url}`)}
                                onClick={() => void toggleSelectLive(item)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {liveUngrouped.map((item) => (
                    <LiveItemButton
                      key={item.url}
                      item={item}
                      isSelected={selected.has(`live:${item.url}`)}
                      onClick={() => void toggleSelectLive(item)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="max-h-[45vh] w-full shrink-0 overflow-y-auto border-t border-border p-3 sm:p-4 md:h-auto md:max-h-none md:w-[380px] md:border-l md:border-t-0">
            <h3 className="mb-2 text-sm font-medium text-ink">Review &amp; publish ({publishableCount})</h3>
            <div className="space-y-3">
              {selectedList.map((entry) => {
                const result = publishResults.get(entry.key);
                return (
                <div key={entry.key} className="rounded-lg border border-border bg-canvas p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-xs text-ink-dim">{entry.title}</p>
                    <div className="flex items-center gap-1.5">
                      {result?.status === "success" && (
                        <CheckCircle2 size={14} className="text-live" aria-label="Posted" />
                      )}
                      <button onClick={() => removeSelected(entry.key)} className="text-alert">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  {result?.status === "error" && (
                    <p className="mt-1 text-[11px] text-alert">{result.message || "Publish failed."}</p>
                  )}
                  {entry.kind === "live" && entry.resolveError && (
                    <p className="mt-1 text-[11px] text-alert">{entry.resolveError}</p>
                  )}
                  {entry.kind === "live" && entry.captionLoading && !entry.resolveError && (
                    <p className="mt-1 text-[11px] text-ink-dim">Resolving real video from {entry.sourceLabel}…</p>
                  )}
                  <textarea
                    value={entry.captionLoading ? "Generating caption…" : entry.caption}
                    disabled={entry.captionLoading}
                    onChange={(e) => updateSelected(entry.key, { caption: e.target.value })}
                    rows={3}
                    className="input mt-2 text-xs"
                  />
                  <input
                    value={entry.tags}
                    onChange={(e) => updateSelected(entry.key, { tags: e.target.value })}
                    placeholder="tags, comma, separated"
                    className="input mt-2 text-xs"
                  />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {PUBLISH_PLATFORMS.map((p) => {
                      const isConnected = connectedPlatforms.includes(p);
                      const rateLimitedUntil = rateLimitedUntilByPlatform.get(p);
                      const isDisabled = !isConnected || Boolean(rateLimitedUntil);
                      const isOn = entry.platforms.includes(p);
                      const disabledReason = !isConnected
                        ? `${PUBLISH_PLATFORM_LABELS[p]} isn't connected on this channel`
                        : rateLimitedUntil
                          ? `${PUBLISH_PLATFORM_LABELS[p]} is rate-limited until ${new Date(rateLimitedUntil).toLocaleString()} (${formatTimeRemaining(rateLimitedUntil)} left)`
                          : undefined;
                      return (
                        <button
                          key={p}
                          type="button"
                          disabled={isDisabled}
                          onClick={() => togglePlatformForEntry(entry.key, p)}
                          title={disabledReason}
                          className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
                            isDisabled
                              ? "cursor-not-allowed border-border/40 text-ink-dim/40"
                              : isOn
                                ? "border-signal bg-signal/10 text-signal"
                                : "border-border text-ink-dim hover:text-ink"
                          }`}
                        >
                          {PUBLISH_PLATFORM_LABELS[p]}
                          {rateLimitedUntil ? ` (${formatTimeRemaining(rateLimitedUntil)} left)` : ""}
                        </button>
                      );
                    })}
                  </div>
                  {entry.platforms.length === 0 && (
                    <p className="mt-1 text-[11px] text-alert">No platform selected - this item won&apos;t be published.</p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => setSongPickerFor(songPickerFor === entry.key ? null : entry.key)}
                      className={`rounded-full border p-1.5 ${entry.songId || entry.noSong ? "border-live/40 text-live" : "border-border text-ink-dim"}`}
                    >
                      <Music size={13} />
                    </button>
                    <span className="text-[11px] text-ink-dim">
                      {entry.noSong
                        ? "No soundtrack"
                        : entry.songId
                          ? songs.find((s) => s.id === entry.songId)?.title ?? "Song selected"
                          : "Auto soundtrack"}
                    </span>
                  </div>
                  {songPickerFor === entry.key && (
                    <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border bg-surface p-2">
                      <button
                        onClick={() => {
                          updateSelected(entry.key, { noSong: true, songId: null });
                          setSongPickerFor(null);
                        }}
                        className="block w-full rounded px-2 py-1 text-left text-xs text-ink-dim hover:bg-canvas"
                      >
                        No soundtrack
                      </button>
                      <button
                        onClick={() => {
                          updateSelected(entry.key, { noSong: false, songId: null });
                          setSongPickerFor(null);
                        }}
                        className="block w-full rounded px-2 py-1 text-left text-xs text-ink-dim hover:bg-canvas"
                      >
                        Auto (let it pick)
                      </button>
                      {songs.map((song) => (
                        <button
                          key={song.id}
                          onClick={() => {
                            updateSelected(entry.key, { noSong: false, songId: song.id });
                            setSongPickerFor(null);
                          }}
                          className="block w-full rounded px-2 py-1 text-left text-xs text-ink hover:bg-canvas"
                        >
                          {song.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                );
              })}
              {selectedList.length === 0 && <p className="text-xs text-ink-dim">Click items on the left to add them here.</p>}
            </div>
          </div>
        </div>

        <div className="border-t border-border p-3 sm:p-4">
          <button onClick={publishAll} disabled={publishing || publishableCount === 0} className="btn-primary w-full">
            {publishing
              ? publishProgress
                ? `Publishing ${publishProgress.done}/${publishProgress.total}…`
                : "Publishing…"
              : `Publish all (${publishableCount})`}
          </button>
        </div>
      </div>
    </div>

  );
}

function LiveItemButton({ item, isSelected, onClick }: { item: LiveItem; isSelected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full rounded-lg border p-3 text-left text-xs ${
        isSelected ? "border-signal ring-2 ring-signal/50" : "border-border"
      }`}
    >
      <p className="truncate font-medium text-ink">{item.title}</p>
      <p className="mt-1 truncate text-ink-dim">{item.description}</p>
      <span className="mt-1 inline-block rounded-full bg-canvas px-2 py-0.5 text-[10px] text-ink-dim">{item.source}</span>
    </button>
  );
}
