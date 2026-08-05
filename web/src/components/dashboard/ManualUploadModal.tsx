"use client";

import { useEffect, useState } from "react";
import { X, ChevronDown, ChevronRight, Music, Trash2 } from "lucide-react";
import type { BotWithHealth, Song } from "@/types/app";
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

interface SelectedItem {
  item: VaultItem;
  caption: string;
  tags: string;
  songId: string | null;
  noSong: boolean;
  captionLoading: boolean;
}

interface ManualUploadModalProps {
  bots: BotWithHealth[];
  onClose: () => void;
}

export function ManualUploadModal({ bots, onClose }: ManualUploadModalProps) {
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [itemsByCategory, setItemsByCategory] = useState<Record<string, VaultItem[]>>({});
  const [loadingCategory, setLoadingCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, SelectedItem>>(new Map());
  const [songs, setSongs] = useState<Song[]>([]);
  const [songPickerFor, setSongPickerFor] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const toggleSelect = async (item: VaultItem) => {
    const next = new Map(selected);
    if (next.has(item.id)) {
      next.delete(item.id);
      setSelected(next);
      return;
    }
    next.set(item.id, { item, caption: "", tags: "", songId: null, noSong: false, captionLoading: true });
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
      const existing = updated.get(item.id);
      if (!existing) return prev;
      updated.set(item.id, {
        ...existing,
        caption: result.ok ? result.data?.caption ?? "" : "",
        tags: result.ok ? (result.data?.tags ?? []).join(", ") : "",
        captionLoading: false,
      });
      return updated;
    });
  };

  const updateSelected = (id: string, patch: Partial<SelectedItem>) => {
    setSelected((prev) => {
      const updated = new Map(prev);
      const existing = updated.get(id);
      if (!existing) return prev;
      updated.set(id, { ...existing, ...patch });
      return updated;
    });
  };

  const removeSelected = (id: string) => {
    const next = new Map(selected);
    next.delete(id);
    setSelected(next);
  };

  const publishAll = async () => {
    if (!botId || selected.size === 0) return;
    setPublishing(true);
    setResultMessage(null);
    setError(null);
    try {
      const items = Array.from(selected.values()).map((entry) => ({
        vaultItemId: entry.item.id,
        caption: entry.caption,
        tags: entry.tags.split(",").map((t) => t.trim()).filter(Boolean),
        songId: entry.songId,
        noSong: entry.noSong,
      }));

      const result = await safeFetchJson<{ publishedCount?: number; totalCount?: number; error?: string }>(
        `/api/bots/${botId}/manual-publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items }),
        },
      );

      if (!result.ok) throw new Error(result.error || "Publish failed.");
      setResultMessage(`Published ${result.data?.publishedCount ?? 0} of ${result.data?.totalCount ?? items.length}.`);
      setSelected(new Map());
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Publish failed.");
    } finally {
      setPublishing(false);
    }
  };

  const selectedList = Array.from(selected.values());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex h-[90vh] w-full max-w-5xl flex-col rounded-2xl border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="font-display text-xl text-ink">Manual upload</h2>
            <p className="text-xs text-faded">Hand-pick meme vault content and publish it directly.</p>
          </div>
          <button onClick={onClose} className="rounded-full border border-border p-2 text-faded hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <span className="text-xs text-faded">Publish to</span>
          <select value={botId} onChange={(e) => setBotId(e.target.value)} className="input max-w-xs">
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </div>

        {error && <p className="px-5 pt-3 text-xs text-alert">{error}</p>}
        {resultMessage && <p className="px-5 pt-3 text-xs text-live">{resultMessage}</p>}

        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-y-auto p-4">
            {categories.map((cat) => (
              <div key={cat.category} className="mb-2 rounded-lg border border-border">
                <button
                  onClick={() => void toggleCategory(cat.category)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-ink"
                >
                  <span className="flex items-center gap-2">
                    {expanded.has(cat.category) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {cat.category}
                  </span>
                  <span className="font-data text-[11px] text-faded">
                    {cat.images} img · {cat.videos} vid
                  </span>
                </button>
                {expanded.has(cat.category) && (
                  <div className="grid grid-cols-3 gap-2 border-t border-border p-3 md:grid-cols-4">
                    {loadingCategory === cat.category && <p className="col-span-full text-xs text-faded">Loading…</p>}
                    {(itemsByCategory[cat.category] ?? []).map((item) => {
                      const isSelected = selected.has(item.id);
                      return (
                        <button
                          key={item.id}
                          onClick={() => void toggleSelect(item)}
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
          </div>

          <div className="w-[380px] shrink-0 overflow-y-auto border-l border-border p-4">
            <h3 className="mb-2 text-sm font-medium text-ink">Review &amp; publish ({selectedList.length})</h3>
            <div className="space-y-3">
              {selectedList.map(({ item, caption, tags, songId, noSong, captionLoading }) => (
                <div key={item.id} className="rounded-lg border border-border bg-canvas p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-xs text-faded">{item.originalFilename}</p>
                    <button onClick={() => removeSelected(item.id)} className="text-alert">
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <textarea
                    value={captionLoading ? "Generating caption…" : caption}
                    disabled={captionLoading}
                    onChange={(e) => updateSelected(item.id, { caption: e.target.value })}
                    rows={3}
                    className="input mt-2 text-xs"
                  />
                  <input
                    value={tags}
                    onChange={(e) => updateSelected(item.id, { tags: e.target.value })}
                    placeholder="tags, comma, separated"
                    className="input mt-2 text-xs"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => setSongPickerFor(songPickerFor === item.id ? null : item.id)}
                      className={`rounded-full border p-1.5 ${songId || noSong ? "border-live/40 text-live" : "border-border text-faded"}`}
                    >
                      <Music size={13} />
                    </button>
                    <span className="text-[11px] text-faded">
                      {noSong ? "No soundtrack" : songId ? songs.find((s) => s.id === songId)?.title ?? "Song selected" : "Auto soundtrack"}
                    </span>
                  </div>
                  {songPickerFor === item.id && (
                    <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border bg-surface p-2">
                      <button
                        onClick={() => {
                          updateSelected(item.id, { noSong: true, songId: null });
                          setSongPickerFor(null);
                        }}
                        className="block w-full rounded px-2 py-1 text-left text-xs text-faded hover:bg-canvas"
                      >
                        No soundtrack
                      </button>
                      <button
                        onClick={() => {
                          updateSelected(item.id, { noSong: false, songId: null });
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
                            updateSelected(item.id, { noSong: false, songId: song.id });
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

        <div className="border-t border-border p-4">
          <button onClick={publishAll} disabled={publishing || selectedList.length === 0} className="btn-primary w-full">
            {publishing ? "Publishing…" : `Publish all (${selectedList.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
