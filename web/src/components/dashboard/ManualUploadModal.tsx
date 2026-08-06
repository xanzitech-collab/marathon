"use client";

import { useEffect, useState } from "react";
import { X, ChevronDown, ChevronRight, Music, Trash2, Radio } from "lucide-react";
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

  const [selected, setSelected] = useState<Map<string, SelectedEntry>>(new Map());
  const [songs, setSongs] = useState<Song[]>([]);
  const [songPickerFor, setSongPickerFor] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connectedPlatforms = bots.find((b) => b.id === botId)?.health.connectedPlatforms ?? [];

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
    const result = await safeFetchJson<{ items?: LiveItem[]; error?: string }>(`/api/live-discovery?platform=${nextPlatform}`);
    setLiveLoading(false);
    if (result.ok) setLiveItems(result.data?.items ?? []);
    else setLiveError(result.error || "Couldn't load live content for this platform.");
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
    try {
      const entries = Array.from(selected.values());
      const vaultItems = entries
        .filter((e) => e.kind === "vault" && e.vaultItemId && e.platforms.length > 0)
        .map((e) => ({
          vaultItemId: e.vaultItemId,
          caption: e.caption,
          tags: e.tags.split(",").map((t) => t.trim()).filter(Boolean),
          songId: e.songId,
          noSong: e.noSong,
          platforms: e.platforms,
        }));
      const liveEntries = entries
        .filter((e) => e.kind === "live" && e.mediaAssetId && !e.resolveError && e.platforms.length > 0)
        .map((e) => ({
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
        }));

      let publishedCount = 0;
      let totalCount = 0;

      if (vaultItems.length > 0) {
        const result = await safeFetchJson<{ publishedCount?: number; totalCount?: number; error?: string }>(
          `/api/bots/${botId}/manual-publish`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: vaultItems }) },
        );
        if (!result.ok) throw new Error(result.error || "Vault publish failed.");
        publishedCount += result.data?.publishedCount ?? 0;
        totalCount += result.data?.totalCount ?? vaultItems.length;
      }

      if (liveEntries.length > 0) {
        const result = await safeFetchJson<{ publishedCount?: number; totalCount?: number; error?: string }>(
          `/api/bots/${botId}/live-publish`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: liveEntries }) },
        );
        if (!result.ok) throw new Error(result.error || "Live publish failed.");
        publishedCount += result.data?.publishedCount ?? 0;
        totalCount += result.data?.totalCount ?? liveEntries.length;
      }

      setResultMessage(`Published ${publishedCount} of ${totalCount}.`);
      setSelected(new Map());
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Publish failed.");
    } finally {
      setPublishing(false);
    }
  };

  const selectedList = Array.from(selected.values());
  const publishableCount = selectedList.filter(
    (e) => (e.kind === "vault" || (e.mediaAssetId && !e.resolveError)) && e.platforms.length > 0,
  ).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 sm:p-4">
      <div className="flex h-full w-full flex-col rounded-none border-0 border-border bg-surface sm:h-[90vh] sm:max-w-5xl sm:rounded-2xl sm:border">
        <div className="flex items-center justify-between border-b border-border px-4 py-4 sm:px-5">
          <div>
            <h2 className="font-display text-xl text-ink">Manual upload</h2>
            <p className="text-xs text-faded">Hand-pick content and publish it directly.</p>
          </div>
          <button onClick={onClose} className="rounded-full border border-border p-2 text-faded hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
          <span className="text-xs text-faded">Publish to</span>
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
              className={`rounded-md px-3 py-1 text-xs ${tab === "vault" ? "bg-signal text-canvas" : "text-faded"}`}
            >
              Vault
            </button>
            <button
              onClick={openLiveTab}
              className={`flex items-center gap-1 rounded-md px-3 py-1 text-xs ${tab === "live" ? "bg-signal text-canvas" : "text-faded"}`}
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
                      <span className="shrink-0 font-data text-[11px] text-faded">
                        {cat.images} img · {cat.videos} vid
                      </span>
                    </button>
                    {expanded.has(cat.category) && (
                      <div className="grid grid-cols-3 gap-2 border-t border-border p-3 md:grid-cols-4">
                        {loadingCategory === cat.category && <p className="col-span-full text-xs text-faded">Loading…</p>}
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
                {categories.length === 0 && !error && <p className="text-sm text-faded">Loading categories…</p>}
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
                        platform === p.id ? "border-signal bg-signal/10 text-signal" : "border-border text-faded"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                {liveLoading && <p className="text-sm text-faded">Searching {platform}…</p>}
                {liveError && <p className="text-xs text-alert">{liveError}</p>}
                {!liveLoading && !liveError && liveItems.length === 0 && (
                  <p className="text-sm text-faded">No recent {platform} content found. Try another platform.</p>
                )}
                <div className="space-y-2">
                  {liveItems.map((item) => {
                    const key = `live:${item.url}`;
                    const isSelected = selected.has(key);
                    return (
                      <button
                        key={item.url}
                        onClick={() => void toggleSelectLive(item)}
                        className={`block w-full rounded-lg border p-3 text-left text-xs ${
                          isSelected ? "border-signal ring-2 ring-signal/50" : "border-border"
                        }`}
                      >
                        <p className="truncate font-medium text-ink">{item.title}</p>
                        <p className="mt-1 truncate text-faded">{item.description}</p>
                        <span className="mt-1 inline-block rounded-full bg-canvas px-2 py-0.5 text-[10px] text-faded">{item.source}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div className="max-h-[45vh] w-full shrink-0 overflow-y-auto border-t border-border p-3 sm:p-4 md:h-auto md:max-h-none md:w-[380px] md:border-l md:border-t-0">
            <h3 className="mb-2 text-sm font-medium text-ink">Review &amp; publish ({publishableCount})</h3>
            <div className="space-y-3">
              {selectedList.map((entry) => (
                <div key={entry.key} className="rounded-lg border border-border bg-canvas p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-xs text-faded">{entry.title}</p>
                    <button onClick={() => removeSelected(entry.key)} className="text-alert">
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {entry.kind === "live" && entry.resolveError && (
                    <p className="mt-1 text-[11px] text-alert">{entry.resolveError}</p>
                  )}
                  {entry.kind === "live" && entry.captionLoading && !entry.resolveError && (
                    <p className="mt-1 text-[11px] text-faded">Resolving real video from {entry.sourceLabel}…</p>
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
                      const isOn = entry.platforms.includes(p);
                      return (
                        <button
                          key={p}
                          type="button"
                          disabled={!isConnected}
                          onClick={() => togglePlatformForEntry(entry.key, p)}
                          title={isConnected ? undefined : `${PUBLISH_PLATFORM_LABELS[p]} isn't connected on this channel`}
                          className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
                            !isConnected
                              ? "cursor-not-allowed border-border/40 text-faded/40"
                              : isOn
                                ? "border-signal bg-signal/10 text-signal"
                                : "border-border text-faded hover:text-ink"
                          }`}
                        >
                          {PUBLISH_PLATFORM_LABELS[p]}
                        </button>
                      );
                    })}
                  </div>
                  {entry.platforms.length === 0 && (
                    <p className="mt-1 text-[11px] text-alert">No platform selected — this item won&apos;t be published.</p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => setSongPickerFor(songPickerFor === entry.key ? null : entry.key)}
                      className={`rounded-full border p-1.5 ${entry.songId || entry.noSong ? "border-live/40 text-live" : "border-border text-faded"}`}
                    >
                      <Music size={13} />
                    </button>
                    <span className="text-[11px] text-faded">
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
                        className="block w-full rounded px-2 py-1 text-left text-xs text-faded hover:bg-canvas"
                      >
                        No soundtrack
                      </button>
                      <button
                        onClick={() => {
                          updateSelected(entry.key, { noSong: false, songId: null });
                          setSongPickerFor(null);
                        }}
                        className="block w-full rounded px-2 py-1 text-left text-xs text-faded hover:bg-canvas"
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
              ))}
              {selectedList.length === 0 && <p className="text-xs text-faded">Click items on the left to add them here.</p>}
            </div>
          </div>
        </div>

        <div className="border-t border-border p-3 sm:p-4">
          <button onClick={publishAll} disabled={publishing || publishableCount === 0} className="btn-primary w-full">
            {publishing ? "Publishing…" : `Publish all (${publishableCount})`}
          </button>
        </div>
      </div>
    </div>

  );
}
