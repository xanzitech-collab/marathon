"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle, Pencil, Trash2 } from "lucide-react";
import type { BotWithHealth, ConnectablePlatform, MediaAsset, QueueItem, Song } from "@/types/app";
import { CONTENT_TARGET_OPTIONS, FREQUENCY_OPTIONS, PERSONA_OPTIONS, WEEKDAYS } from "@/lib/config";
import { safeFetchJson } from "@/lib/safe-fetch";

interface SpeechRecognitionResultLike {
  transcript: string;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<SpeechRecognitionResultLike>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const browserWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition ?? null;
}

interface BotCardProps {
  bot: BotWithHealth;
  onUpdated: () => Promise<void>;
}

interface LivePost {
  id: string;
  message: string;
  createdTime: string;
  picture?: string;
  permalink?: string;
  mediaType?: string;
  likeCount: number;
  commentCount: number;
}

interface PostComment {
  id: string;
  message: string;
  from?: string;
  createdTime: string;
}

const PLATFORMS: ConnectablePlatform[] = ["instagram", "tiktok", "facebook"];
const PLATFORM_LABELS: Record<ConnectablePlatform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  facebook: "Facebook",
};

export function BotCard({ bot, onUpdated }: BotCardProps) {
  const [expanded, setExpanded] = useState(() => !bot.health.anyPlatformConnected);
  const [tab, setTab] = useState<"voice" | "media" | "activity" | "posts">("voice");
  const [queueView, setQueueView] = useState<"all" | "failed">("all");
  const [posts, setPosts] = useState<LivePost[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [deletingPostId, setDeletingPostId] = useState<string | null>(null);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [editCaptionText, setEditCaptionText] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [commentsOpenFor, setCommentsOpenFor] = useState<string | null>(null);
  const [commentsByPost, setCommentsByPost] = useState<Record<string, PostComment[]>>({});
  const [commentsLoading, setCommentsLoading] = useState<string | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [newCommentText, setNewCommentText] = useState<Record<string, string>>({});
  const [commentPosting, setCommentPosting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [songs, setSongs] = useState<Song[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [missionText, setMissionText] = useState(bot.custom_target_prompt ?? "");
  const [missionLoading, setMissionLoading] = useState(false);
  const [automationLoading, setAutomationLoading] = useState(false);
  const [publishLoading, setPublishLoading] = useState(false);
  const [instagramActionLoading, setInstagramActionLoading] = useState<ConnectablePlatform | null>(null);
  const [queueActionMessage, setQueueActionMessage] = useState<string | null>(null);
  const [voiceSupported] = useState<boolean>(() => Boolean(getSpeechRecognitionCtor()));
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const [form, setForm] = useState({
    name: bot.name,
    is_active: bot.is_active,
    timezone: bot.timezone,
    country: bot.country ?? "",
    city: bot.city ?? "",
    language: bot.language,
    persona: bot.persona,
    additional_persona: bot.additional_persona ?? "",
    content_target: bot.content_target,
    custom_target_prompt: bot.custom_target_prompt ?? "",
    frequency_mode: bot.frequency_mode,
    every_n_days: bot.every_n_days ?? 2,
    weekdays: bot.weekdays,
    max_posts_per_day: bot.max_posts_per_day,
    cooldown_minutes: bot.cooldown_minutes,
  });

  const loadQueue = useCallback(async () => {
    const result = await safeFetchJson<{ queue?: QueueItem[]; error?: string }>(`/api/bots/${bot.id}/queue`, { cache: "no-store" });
    if (!result.ok) {
      setQueueActionMessage(result.error || "Couldn't load recent activity.");
      return;
    }
    setQueue(result.data?.queue ?? []);
  }, [bot.id]);

  useEffect(() => {
    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) return;
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = Array.from({ length: event.results.length - event.resultIndex }, (_, index) => {
        const result = event.results[event.resultIndex + index];
        return result?.[0]?.transcript ?? "";
      }).join(" ").trim();
      if (transcript) {
        setMissionText((prev) => `${prev}${prev ? "\n" : ""}${transcript}`.trim());
      }
    };
    recognition.onerror = (event) => {
      setVoiceError(event.error === "not-allowed" ? "Microphone access was denied." : `Voice capture failed: ${event.error}`);
      setVoiceListening(false);
    };
    recognition.onend = () => setVoiceListening(false);
    recognitionRef.current = recognition;
    return () => recognition.stop();
  }, []);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      const result = await safeFetchJson<{ queue?: QueueItem[]; error?: string }>(`/api/bots/${bot.id}/queue`, { cache: "no-store" });
      if (ignore) return;
      if (!result.ok) {
        setQueueActionMessage(result.error || "Couldn't load recent activity.");
        return;
      }
      setQueue(result.data?.queue ?? []);
    })();
    return () => { ignore = true; };
  }, [bot.id]);

  useEffect(() => {
    if (!expanded) return;
    let ignore = false;
    void (async () => {
      const result = await safeFetchJson<{ queue?: QueueItem[]; error?: string }>(`/api/bots/${bot.id}/queue`, { cache: "no-store" });
      if (ignore) return;
      if (!result.ok) {
        setQueueActionMessage(result.error || "Couldn't load recent activity.");
        return;
      }
      setQueue(result.data?.queue ?? []);
    })();
    return () => { ignore = true; };
  }, [expanded, bot.id]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const timer = window.setInterval(() => { void loadQueue(); }, 8000);
    return () => window.clearInterval(timer);
  }, [loadQueue]);

  const setupSteps = useMemo(
    () => [
      { label: "A platform connected", done: bot.health.anyPlatformConnected },
      { label: "Publishing connection ready", done: bot.health.xenrioKeyConnected },
      { label: "Caption writer ready", done: bot.health.geminiKeyConnected },
      { label: "Channel turned on", done: form.is_active },
    ],
    [bot.health.anyPlatformConnected, bot.health.geminiKeyConnected, bot.health.xenrioKeyConnected, form.is_active],
  );

  const updateBot = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await safeFetchJson<{ bot?: BotWithHealth; error?: unknown }>(`/api/bots/${bot.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          country: form.country || null,
          city: form.city || null,
          additional_persona: form.additional_persona || null,
          custom_target_prompt: form.custom_target_prompt || null,
          every_n_days: form.frequency_mode === "every_n_days" ? form.every_n_days : null,
        }),
      });
      if (!result.ok) {
        setSaveError(result.error || "Couldn't save your changes.");
        return;
      }
      await onUpdated();
    } finally {
      setSaving(false);
    }
  };

  // On/off is a quick-action toggle, not part of the "edit settings, then
  // hit Save" flow — it needs to persist immediately on click. Previously it
  // only flipped local form state, so it silently reverted on refresh unless
  // the user also separately clicked Save right after.
  const toggleActive = async () => {
    const nextActive = !form.is_active;
    setForm({ ...form, is_active: nextActive });
    setSaving(true);
    setSaveError(null);
    try {
      // The PATCH endpoint validates the full bot payload, not a partial
      // one — sending just { is_active } fails schema validation with 400.
      const result = await safeFetchJson<{ bot?: BotWithHealth; error?: unknown }>(`/api/bots/${bot.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          is_active: nextActive,
          country: form.country || null,
          city: form.city || null,
          additional_persona: form.additional_persona || null,
          custom_target_prompt: form.custom_target_prompt || null,
          every_n_days: form.frequency_mode === "every_n_days" ? form.every_n_days : null,
        }),
      });
      if (!result.ok) {
        setForm({ ...form, is_active: !nextActive });
        setSaveError(result.error || "Couldn't change that.");
        return;
      }
      await onUpdated();
    } finally {
      setSaving(false);
    }
  };

  const connectInstagram = async (platform: ConnectablePlatform) => {
    setInstagramActionLoading(platform);
    window.location.assign(`/api/bots/${bot.id}/connect?mode=start&platform=${platform}`);
  };

  const disconnectInstagram = async (platform: ConnectablePlatform) => {
    setInstagramActionLoading(platform);
    setQueueActionMessage(null);
    try {
      const result = await safeFetchJson<{ error?: string }>(`/api/bots/${bot.id}/connect?platform=${platform}`, { method: "DELETE" });
      if (!result.ok) {
        setQueueActionMessage(result.error || `Couldn't disconnect ${PLATFORM_LABELS[platform]}.`);
        return;
      }
      setQueueActionMessage(`${PLATFORM_LABELS[platform]} disconnected.`);
      await onUpdated();
    } finally {
      setInstagramActionLoading(null);
    }
  };

  const syncPlatform = async (platform: ConnectablePlatform) => {
    setInstagramActionLoading(platform);
    setQueueActionMessage(null);
    try {
      const result = await safeFetchJson<{ error?: string }>(`/api/bots/${bot.id}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "sync", platform }),
      });
      if (!result.ok) {
        setQueueActionMessage(result.error || `Couldn't sync ${PLATFORM_LABELS[platform]}. Finish connecting it on ${PLATFORM_LABELS[platform]}/Zernio first.`);
        return;
      }
      setQueueActionMessage(`${PLATFORM_LABELS[platform]} synced.`);
      await onUpdated();
    } finally {
      setInstagramActionLoading(null);
    }
  };

  const buildMission = async () => {
    setMissionLoading(true);
    try {
      const missionResult = await safeFetchJson<{ bot?: BotWithHealth; error?: string }>(`/api/bots/${bot.id}/mission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ missionText }),
      });
      if (!missionResult.ok) throw new Error(missionResult.error || "Couldn't build a plan from that.");

      const discoverResult = await safeFetchJson<{ error?: string }>(`/api/bots/${bot.id}/discover`, { method: "POST" });
      if (!discoverResult.ok) throw new Error(discoverResult.error || "Plan saved, but finding content failed.");

      const tickResult = await safeFetchJson<{ error?: string }>(`/api/scheduler/tick`, { method: "POST" });
      if (!tickResult.ok) throw new Error(tickResult.error || "Content found, but scheduling failed.");

      await loadQueue();
      await onUpdated();
    } catch (error) {
      setQueueActionMessage(error instanceof Error ? error.message : "Couldn't build a plan from that.");
    } finally {
      setMissionLoading(false);
    }
  };

  const startVoiceCapture = () => {
    if (!voiceSupported || !recognitionRef.current) {
      setVoiceError("Voice capture isn't supported in this browser.");
      return;
    }
    setVoiceError(null);
    setVoiceListening(true);
    recognitionRef.current.start();
  };

  const runAutomationCycle = async () => {
    setAutomationLoading(true);
    setQueueActionMessage(null);
    try {
      const discoveryResult = await safeFetchJson<{ discovered?: number; queued?: number; skipped?: number; error?: string }>(
        `/api/bots/${bot.id}/discover`,
        { method: "POST" },
      );
      const tickResult = await safeFetchJson<{ processed?: number; error?: string }>(`/api/scheduler/tick`, { method: "POST" });

      if (!discoveryResult.ok || !tickResult.ok) {
        throw new Error(discoveryResult.error || tickResult.error || "The run didn't complete.");
      }

      const discovered = typeof discoveryResult.data?.discovered === "number" ? discoveryResult.data.discovered : 0;
      const queued = typeof discoveryResult.data?.queued === "number" ? discoveryResult.data.queued : 0;
      const skipped = typeof discoveryResult.data?.skipped === "number" ? discoveryResult.data.skipped : 0;
      setQueueActionMessage(`Found ${discovered}, queued ${queued}, skipped ${skipped}.`);
      await loadQueue();
      await onUpdated();
    } catch (error) {
      setQueueActionMessage(error instanceof Error ? error.message : "The run didn't complete.");
    } finally {
      setAutomationLoading(false);
    }
  };

  const loadMedia = async () => {
    const result = await safeFetchJson<{ media?: MediaAsset[]; error?: string }>(`/api/bots/${bot.id}/media`);
    if (!result.ok) {
      setQueueActionMessage(result.error || "Couldn't load your media.");
      return;
    }
    setMedia(result.data?.media ?? []);
  };

  const loadSongs = async () => {
    const result = await safeFetchJson<{ songs?: Song[]; error?: string }>(`/api/bots/${bot.id}/songs`);
    if (!result.ok) {
      setQueueActionMessage(result.error || "Couldn't load your songs.");
      return;
    }
    setSongs(result.data?.songs ?? []);
  };

  const loadPosts = async () => {
    setPostsLoading(true);
    setPostsError(null);
    const result = await safeFetchJson<{ posts?: LivePost[]; error?: string }>(`/api/bots/${bot.id}/posts`);
    if (!result.ok) {
      setPostsError(result.error || "Couldn't load posts.");
      setPostsLoading(false);
      return;
    }
    setPosts(result.data?.posts ?? []);
    setPostsLoading(false);
  };

  const deletePost = async (postId: string) => {
    if (!window.confirm("Delete this post from Instagram? This can't be undone.")) return;
    setDeletingPostId(postId);
    const result = await safeFetchJson<{ error?: string }>(`/api/bots/${bot.id}/posts?postId=${encodeURIComponent(postId)}`, {
      method: "DELETE",
    });
    setDeletingPostId(null);
    if (!result.ok) {
      setPostsError(result.error || "Couldn't delete that post.");
      return;
    }
    setPosts((prev) => prev.filter((p) => p.id !== postId));
  };

  const startEditPost = (post: LivePost) => {
    setEditingPostId(post.id);
    setEditCaptionText(post.message || "");
    setEditError(null);
  };

  const cancelEditPost = () => {
    setEditingPostId(null);
    setEditCaptionText("");
    setEditError(null);
  };

  const saveEditPost = async (postId: string) => {
    setEditSaving(true);
    setEditError(null);
    const result = await safeFetchJson<{ error?: string }>(`/api/bots/${bot.id}/posts`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postId, caption: editCaptionText }),
    });
    setEditSaving(false);
    if (!result.ok) {
      setEditError(result.error || "Couldn't update that post.");
      return;
    }
    setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, message: editCaptionText } : p)));
    setEditingPostId(null);
  };

  const loadComments = async (postId: string) => {
    setCommentsLoading(postId);
    setCommentsError(null);
    const result = await safeFetchJson<{ comments?: PostComment[]; error?: string }>(`/api/bots/${bot.id}/posts/${postId}/comments`);
    setCommentsLoading(null);
    if (!result.ok) {
      setCommentsError(result.error || "Couldn't load comments.");
      return;
    }
    setCommentsByPost((prev) => ({ ...prev, [postId]: result.data?.comments ?? [] }));
  };

  const toggleComments = (postId: string) => {
    if (commentsOpenFor === postId) {
      setCommentsOpenFor(null);
      return;
    }
    setCommentsOpenFor(postId);
    setCommentsError(null);
    if (!commentsByPost[postId]) void loadComments(postId);
  };

  const postComment = async (postId: string) => {
    const message = (newCommentText[postId] ?? "").trim();
    if (!message) return;
    setCommentPosting(postId);
    setCommentsError(null);
    const result = await safeFetchJson<{ comment?: { id: string }; error?: string }>(`/api/bots/${bot.id}/posts/${postId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    setCommentPosting(null);
    if (!result.ok) {
      setCommentsError(result.error || "Couldn't post that comment.");
      return;
    }
    setNewCommentText((prev) => ({ ...prev, [postId]: "" }));
    await loadComments(postId);
  };

  const publishNow = async () => {
    if (publishLoading) return;
    setPublishLoading(true);
    setQueueActionMessage(null);
    try {
      const query = process.env.NODE_ENV !== "production" ? "?devBypassLimits=1" : "";
      const result = await safeFetchJson<{ success?: boolean; error?: string; reason?: string }>(`/api/bots/${bot.id}/publish-now${query}`, {
        method: "POST",
      });
      if (!result.ok) {
        setQueueActionMessage(result.error || "Couldn't publish right now.");
      } else if (result.data?.success === false) {
        const reason = result.data?.reason || result.data?.error || "Nothing was ready to publish.";
        setQueueActionMessage(reason);
      } else {
        setQueueActionMessage("Published.");
      }
      await loadQueue();
      await onUpdated();
    } finally {
      setPublishLoading(false);
    }
  };

  const clearQueueScope = async (scope: "queue" | "logs") => {
    setQueueActionMessage(null);
    const result = await safeFetchJson<{ removed?: number; error?: string }>(`/api/bots/${bot.id}/queue?scope=${scope}`, {
      method: "DELETE",
    });
    if (!result.ok) {
      setQueueActionMessage(result.error || `Couldn't clear ${scope}.`);
      return;
    }
    setQueueActionMessage(`Cleared ${result.data?.removed ?? 0} ${scope === "queue" ? "queued" : "log"} item(s).`);
    await loadQueue();
  };

  const isLive = bot.is_active && bot.health.anyPlatformConnected && bot.health.isReady;
  const postedItems = useMemo(() => queue.filter((item) => item.status === "posted"), [queue]);
  const recentPostedItems = useMemo(() => postedItems.slice(0, 3), [postedItems]);

  const formatActivityTime = (value?: string | null) => {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
  };

  const activityFeed = useMemo(() => {
    return [...queue]
      .sort((a, b) => {
        const aTime = new Date(a.published_at ?? a.updated_at ?? a.created_at).getTime();
        const bTime = new Date(b.published_at ?? b.updated_at ?? b.created_at).getTime();
        return bTime - aTime;
      })
      .slice(0, 6);
  }, [queue]);

  const failedItems = useMemo(() => {
    return [...queue]
      .filter((item) => item.status === "failed")
      .sort((a, b) => new Date(b.updated_at ?? b.created_at).getTime() - new Date(a.updated_at ?? a.created_at).getTime())
      .slice(0, 8);
  }, [queue]);

  const visibleActivityFeed = useMemo(
    () => (queueView === "failed" ? activityFeed.filter((item) => item.status === "failed") : activityFeed),
    [activityFeed, queueView],
  );

  const lastPostedLabel = useMemo(() => {
    const latestPosted = [...queue]
      .filter((item) => item.status === "posted" && item.published_at)
      .sort((a, b) => new Date(b.published_at!).getTime() - new Date(a.published_at!).getTime())[0];
    return latestPosted?.published_at ?? bot.last_posted_at ?? null;
  }, [bot.last_posted_at, queue]);

  return (
    <article className="panel">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`tally ${isLive ? "tally-live" : bot.health.isReady ? "tally-signal" : "tally-off"}`} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-medium text-ink">{bot.name}</h3>
            </div>
            <p className="font-data text-xs text-ink-dim">
              CH.{String(bot.api_slot).padStart(2, "0")} · {bot.city || "No city set"}, {bot.country || "No country set"}
            </p>
          </div>
        </div>
        <button onClick={() => setExpanded((v) => !v)} className="btn-secondary px-3 py-1.5 text-xs">
          {expanded ? "Collapse" : "Open"}
        </button>
      </div>

      {!bot.health.isReady && (
        <p className="px-4 pb-3 text-xs text-signal sm:px-5">{bot.health.issues.join(" · ")}</p>
      )}

      <div className="grid grid-cols-2 gap-2 px-4 pb-4 sm:px-5 md:grid-cols-4">
        {setupSteps.map((step) => (
          <div key={step.label} className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5">
            <span className={`tally shrink-0 ${step.done ? "tally-live" : "tally-off"}`} />
            <span className="truncate text-xs text-ink-dim">{step.label}</span>
          </div>
        ))}
      </div>

      {expanded && (
        <div className="border-t border-border p-4 sm:p-5">
          <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg border border-border bg-canvas p-1 text-xs sm:flex sm:text-sm">
            {([
              ["voice", "Voice & schedule"],
              ["media", "Media"],
              ["activity", "Activity"],
              ["posts", "Posts"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => {
                  setTab(key);
                  if (key === "media") { void loadMedia(); void loadSongs(); }
                  if (key === "activity") void loadQueue();
                  if (key === "posts") void loadPosts();
                }}
                className={`rounded-md px-2 py-2 transition sm:flex-1 sm:px-3 ${
                  tab === key ? "bg-signal text-canvas font-medium" : "text-ink-dim hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "voice" && (
            <div className="grid min-w-0 gap-3 md:grid-cols-2">
              <Field label="Channel name">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" />
              </Field>
              <Field label="Timezone">
                <input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} className="input" />
              </Field>
              <Field label="Country">
                <input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} className="input" />
              </Field>
              <Field label="City">
                <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="input" />
              </Field>
              <Field label="Voice">
                <select value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} className="input">
                  {PERSONA_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </Field>
              <Field label="Tone notes">
                <input
                  value={form.additional_persona}
                  onChange={(e) => setForm({ ...form, additional_persona: e.target.value })}
                  placeholder="Warm, bold, fan-first"
                  className="input"
                />
              </Field>
              <Field label="Content focus">
                <select value={form.content_target} onChange={(e) => setForm({ ...form, content_target: e.target.value })} className="input">
                  {CONTENT_TARGET_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </Field>
              <Field label="Posting rhythm">
                <select
                  value={form.frequency_mode}
                  onChange={(e) => setForm({ ...form, frequency_mode: e.target.value as typeof form.frequency_mode })}
                  className="input"
                >
                  {FREQUENCY_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </Field>
              <Field label="Repeat every N days">
                <input
                  type="number" min={2} max={14}
                  value={form.every_n_days}
                  onChange={(e) => setForm({ ...form, every_n_days: Number(e.target.value) })}
                  className="input"
                />
              </Field>
              <Field label="Daily post limit">
                <input
                  type="number" min={1} max={25}
                  value={form.max_posts_per_day}
                  onChange={(e) => setForm({ ...form, max_posts_per_day: Number(e.target.value) })}
                  className="input"
                />
              </Field>
              <Field label="Time between posts (minutes)">
                <input
                  type="number" min={30} max={1440}
                  value={form.cooldown_minutes}
                  onChange={(e) => setForm({ ...form, cooldown_minutes: Number(e.target.value) })}
                  className="input"
                />
              </Field>

              <div className="md:col-span-2">
                <p className="mb-2 text-xs uppercase tracking-wide text-ink-dim">Posting days</p>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map((d) => {
                    const on = form.weekdays.includes(d.value);
                    return (
                      <button
                        key={d.value}
                        onClick={() => {
                          const weekdays = on ? form.weekdays.filter((v) => v !== d.value) : [...form.weekdays, d.value];
                          setForm({ ...form, weekdays });
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs transition ${
                          on ? "bg-live text-canvas font-medium" : "border border-border text-ink-dim hover:text-ink"
                        }`}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="md:col-span-2 rounded-xl border border-border bg-canvas p-4">
                <p className="text-sm font-medium text-ink">Set the plan in your own words</p>
                <p className="mt-1 text-xs text-ink-dim">
                  Type or speak what you want this channel to do - it&apos;ll turn that into a voice, focus, and schedule.
                </p>
                <textarea
                  value={missionText}
                  onChange={(e) => setMissionText(e.target.value)}
                  rows={4}
                  className="input mt-3 resize-none"
                  placeholder="Example: spotlight new releases, engage fans, and lean into reels around the artist's music."
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button onClick={buildMission} disabled={missionLoading || !missionText.trim()} className="btn-primary">
                    {missionLoading ? "Building…" : "Build plan"}
                  </button>
                  <button onClick={startVoiceCapture} disabled={!voiceSupported || voiceListening} className="btn-secondary">
                    {voiceListening ? "Listening…" : "Speak instead"}
                  </button>
                  <button
                    onClick={() => void toggleActive()}
                    disabled={saving}
                    className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                      form.is_active ? "bg-live text-canvas" : "border border-border text-ink-dim hover:text-ink"
                    }`}
                  >
                    {form.is_active ? "Channel is on" : "Channel is off"}
                  </button>
                  <button onClick={updateBot} disabled={saving} className="btn-primary">
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
                {saveError && <p className="mt-2 text-xs text-alert">{saveError}</p>}
                {voiceError && <p className="mt-2 text-xs text-signal">{voiceError}</p>}
              </div>

              <div className="md:col-span-2 rounded-xl border border-border/60 p-3">
                <p className="mb-2 text-xs uppercase tracking-wide text-ink-dim">Publishing platforms</p>
                <p className="mb-3 text-xs text-ink-dim">
                  Connect one or more - when this channel posts, it publishes to every connected platform at once.
                </p>
                <div className="flex flex-wrap gap-2">
                  {PLATFORMS.map((platform) => {
                    const connected = bot.health.connectedPlatforms.includes(platform);
                    const busy = instagramActionLoading === platform;
                    return (
                      <div key={platform} className="flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5">
                        <span className={`tally ${connected ? "tally-live" : "tally-off"}`} />
                        <span className="text-xs text-ink">{PLATFORM_LABELS[platform]}</span>
                        <button
                          onClick={() => (connected ? disconnectInstagram(platform) : connectInstagram(platform))}
                          disabled={busy}
                          className={`ml-1 text-xs ${connected ? "text-alert hover:underline" : "text-signal hover:underline"}`}
                        >
                          {busy ? "Working…" : connected ? "Disconnect" : "Connect"}
                        </button>
                        {!connected && (
                          <button
                            onClick={() => syncPlatform(platform)}
                            disabled={busy}
                            title="Already authorized on the platform/Zernio but not showing here yet? Re-check without redoing OAuth."
                            className="text-xs text-ink-dim hover:text-ink"
                          >
                            Sync
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="md:col-span-2 rounded-xl border border-border/60 p-3 font-data text-xs text-ink-dim">
                <p className="break-all">Profile: {bot.zernio_profile_id || "not linked"}</p>
                {PLATFORMS.map((platform) => {
                  const account = bot.platformAccounts?.find((a) => a.platform === platform);
                  return (
                    <p key={platform} className="break-all">
                      {PLATFORM_LABELS[platform]} account: {account ? (account.username || account.zernio_account_id) : "not synced"}
                    </p>
                  );
                })}
              </div>
            </div>
          )}

          {tab === "media" && (
            <MediaTab botId={bot.id} media={media} onReload={loadMedia} songs={songs} onReloadSongs={loadSongs} />
          )}

          {tab === "activity" && (
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-canvas p-4">
                <div className="flex items-center gap-2">
                  <span className={`tally ${isLive ? "tally-live" : "tally-off"}`} />
                  <p className="text-sm font-medium text-ink">{isLive ? "This channel is live" : "This channel is on standby"}</p>
                </div>
                <p className="mt-1 text-xs text-ink-dim">
                  It finds content, writes captions, and publishes on its own whenever it&apos;s on and connected.
                </p>
                <div className="mt-3 flex flex-wrap gap-3 font-data text-xs">
                  <span className="text-live">{postedItems.length} posted</span>
                  <span className="text-signal">
                    {queue.filter((i) => ["queued", "ready", "publishing"].includes(i.status)).length} queued
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button onClick={runAutomationCycle} disabled={automationLoading} className="btn-primary">
                  {automationLoading ? "Running…" : "Run now"}
                </button>
                <button onClick={publishNow} disabled={publishLoading} className="btn-secondary">
                  {publishLoading ? "Publishing…" : "Publish if ready"}
                </button>
              </div>
              {queueActionMessage && <p className="text-xs text-ink-dim">{queueActionMessage}</p>}

              <div className="rounded-xl border border-border bg-canvas p-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-ink">Recent activity</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-data text-[11px] text-ink-dim">
                      {lastPostedLabel ? `Last posted ${formatActivityTime(lastPostedLabel)}` : "No posts yet"}
                    </span>
                    <button
                      onClick={() => setQueueView("all")}
                      className={`rounded-full px-2.5 py-1 text-[11px] ${queueView === "all" ? "bg-surface-raised text-ink" : "text-ink-dim"}`}
                    >
                      All
                    </button>
                    <button
                      onClick={() => setQueueView("failed")}
                      className={`rounded-full px-2.5 py-1 text-[11px] ${queueView === "failed" ? "bg-alert/20 text-alert" : "text-ink-dim"}`}
                    >
                      Failed
                    </button>
                    <button
                      onClick={() => clearQueueScope("queue")}
                      title="Cancel all queued/ready items"
                      className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] text-ink-dim hover:text-alert"
                    >
                      <Trash2 size={12} /> Clear queue
                    </button>
                  </div>
                </div>
                {visibleActivityFeed.length ? (
                  <div className="space-y-2">
                    {visibleActivityFeed.map((item) => (
                      <div key={item.id} className="rounded-lg border border-border/60 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`font-data text-[10px] uppercase tracking-wide ${
                              item.status === "posted" ? "text-live" : item.status === "failed" ? "text-alert" : "text-signal"
                            }`}
                          >
                            {item.status}
                          </span>
                          <span className="font-data text-[11px] text-ink-dim">
                            {formatActivityTime(item.published_at ?? item.updated_at ?? item.created_at)}
                          </span>
                        </div>
                        <p className="mt-1.5 text-sm text-ink">{item.generated_caption || "No caption yet"}</p>
                        {item.status === "failed" && item.error_message && (
                          <p className="mt-1 text-xs text-alert">{item.error_message}</p>
                        )}
                        {item.status === "posted" && item.error_message && (
                          <p className="mt-1 text-xs text-signal">{item.error_message}</p>
                        )}
                        {item.status === "cancelled" && item.error_message && (
                          <p className="mt-1 text-xs text-ink-dim">{item.error_message}</p>
                        )}
                        {(item.status === "queued" || item.status === "ready") && item.error_message && (
                          <p className="mt-1 text-xs text-signal">{item.error_message}</p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-ink-dim">Nothing here yet.</p>
                )}
              </div>

              {failedItems.length > 0 && (
                <div className="rounded-xl border border-alert/20 bg-alert/5 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-alert">Needs attention</p>
                    <button
                      onClick={() => clearQueueScope("logs")}
                      title="Clear failed/cancelled logs"
                      className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] text-alert/80 hover:text-alert"
                    >
                      <Trash2 size={12} /> Clear logs
                    </button>
                  </div>
                  <div className="space-y-2">
                    {failedItems.map((item) => (
                      <div key={item.id} className="rounded-lg border border-alert/20 p-2.5 text-xs text-alert/90">
                        <p className="font-data">{formatActivityTime(item.updated_at ?? item.created_at)}</p>
                        <p className="mt-1">{item.error_message || "No reason given."}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {recentPostedItems.length > 0 && (
                <div className="rounded-xl border border-border bg-canvas p-3">
                  <p className="mb-2 text-sm font-medium text-ink">Recently published</p>
                  <div className="space-y-2">
                    {recentPostedItems.map((item) => (
                      <div key={item.id} className="rounded-lg border border-border/60 p-2.5 text-sm text-ink">
                        {item.generated_caption || "No caption yet"}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "posts" && (
            <div className="space-y-3">
              {postsLoading && <p className="text-sm text-ink-dim">Loading posts…</p>}
              {postsError && <p className="text-xs text-alert">{postsError}</p>}
              {!postsLoading && !postsError && posts.length === 0 && (
                <p className="text-sm text-ink-dim">No live posts found for this account yet.</p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {posts.map((post) => (
                  <article key={post.id} className="overflow-hidden rounded-xl border border-border bg-canvas">
                    {post.picture && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={post.picture} alt="" className="aspect-square w-full object-cover" />
                    )}
                    <div className="p-3">
                      {editingPostId === post.id ? (
                        <div>
                          <textarea
                            value={editCaptionText}
                            onChange={(e) => setEditCaptionText(e.target.value)}
                            rows={3}
                            className="input text-sm"
                          />
                          {editError && <p className="mt-1 text-xs text-alert">{editError}</p>}
                          <div className="mt-2 flex gap-2">
                            <button onClick={() => void saveEditPost(post.id)} disabled={editSaving} className="btn-primary text-xs">
                              {editSaving ? "Saving…" : "Save"}
                            </button>
                            <button onClick={cancelEditPost} disabled={editSaving} className="btn-secondary text-xs">
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="line-clamp-3 text-sm text-ink">{post.message || "No caption"}</p>
                      )}
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="flex gap-3 font-data text-xs text-ink-dim">
                          <span>♥ {post.likeCount}</span>
                          <button onClick={() => toggleComments(post.id)} className="hover:text-ink">
                            💬 {post.commentCount}
                          </button>
                        </div>
                        <span className="font-data text-[11px] text-ink-dim">{formatActivityTime(post.createdTime)}</span>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {post.permalink && (
                          <a href={post.permalink} target="_blank" rel="noreferrer" className="btn-secondary text-xs">
                            View on Instagram
                          </a>
                        )}
                        {editingPostId !== post.id && (
                          <button
                            onClick={() => startEditPost(post)}
                            className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-ink-dim hover:text-ink"
                          >
                            <Pencil size={12} /> Edit
                          </button>
                        )}
                        <button
                          onClick={() => toggleComments(post.id)}
                          className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-ink-dim hover:text-ink"
                        >
                          <MessageCircle size={12} /> Comments
                        </button>
                        <button
                          onClick={() => deletePost(post.id)}
                          disabled={deletingPostId === post.id}
                          className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-alert hover:underline disabled:opacity-60"
                        >
                          <Trash2 size={12} /> {deletingPostId === post.id ? "Deleting…" : "Delete"}
                        </button>
                      </div>

                      {commentsOpenFor === post.id && (
                        <div className="mt-3 rounded-lg border border-border/60 bg-surface p-2.5">
                          {commentsLoading === post.id && <p className="text-xs text-ink-dim">Loading comments…</p>}
                          {commentsError && <p className="text-xs text-alert">{commentsError}</p>}
                          {commentsLoading !== post.id && (commentsByPost[post.id]?.length ?? 0) === 0 && (
                            <p className="text-xs text-ink-dim">No comments yet.</p>
                          )}
                          <div className="max-h-48 space-y-2 overflow-y-auto">
                            {(commentsByPost[post.id] ?? []).map((comment) => (
                              <div key={comment.id} className="rounded-md border border-border/40 p-2 text-xs">
                                {comment.from && <p className="font-medium text-ink">{comment.from}</p>}
                                <p className="text-ink-dim">{comment.message}</p>
                              </div>
                            ))}
                          </div>
                          <div className="mt-2 flex gap-2">
                            <input
                              value={newCommentText[post.id] ?? ""}
                              onChange={(e) => setNewCommentText((prev) => ({ ...prev, [post.id]: e.target.value }))}
                              placeholder="Write a comment…"
                              className="input text-xs"
                            />
                            <button
                              onClick={() => void postComment(post.id)}
                              disabled={commentPosting === post.id || !(newCommentText[post.id] ?? "").trim()}
                              className="btn-primary whitespace-nowrap text-xs"
                            >
                              {commentPosting === post.id ? "Posting…" : "Reply"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="min-w-0 text-sm text-ink">
      <span className="mb-1 block text-xs text-ink-dim">{label}</span>
      {children}
    </label>
  );
}

interface MediaTabProps {
  botId: string;
  media: MediaAsset[];
  onReload: () => Promise<void>;
  songs: Song[];
  onReloadSongs: () => Promise<void>;
}

function MediaTab({ botId, media, onReload, songs, onReloadSongs }: MediaTabProps) {
  const [url, setUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [tags, setTags] = useState("");
  const [type, setType] = useState<"image" | "video">("image");
  const [uploading, setUploading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [songTitle, setSongTitle] = useState("");
  const [songFileName, setSongFileName] = useState("");
  const [songUploading, setSongUploading] = useState(false);
  const [songError, setSongError] = useState<string | null>(null);
  const songFileInputRef = useRef<HTMLInputElement | null>(null);
  const [deletingMediaId, setDeletingMediaId] = useState<string | null>(null);
  const [deletingSongId, setDeletingSongId] = useState<string | null>(null);

  const addMedia = async () => {
    if ((!url || !caption || !tags) && !fileName) return;
    setUploading(true);
    setMediaError(null);
    try {
      let publicUrl = url;
      let storagePath = `external/${Date.now()}`;
      if (fileName) {
        const formData = new FormData();
        const file = fileInputRef.current?.files?.[0];
        if (!file) return;
        formData.append("file", file);
        formData.append("botId", botId);
        const uploadResult = await safeFetchJson<{ publicUrl?: string; storagePath?: string; error?: string }>("/api/uploads", {
          method: "POST",
          body: formData,
        });
        if (!uploadResult.ok) throw new Error(uploadResult.error || "Upload failed.");
        publicUrl = uploadResult.data?.publicUrl || "";
        storagePath = uploadResult.data?.storagePath || storagePath;
      }
      const createResult = await safeFetchJson<{ media?: MediaAsset; error?: string }>(`/api/bots/${botId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storage_path: storagePath,
          public_url: publicUrl,
          media_type: type,
          media_context_caption: caption,
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });
      if (!createResult.ok) throw new Error(createResult.error || "Couldn't save that.");
      setUrl(""); setCaption(""); setTags(""); setFileName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await onReload();
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const deleteMedia = async (id: string) => {
    if (deletingMediaId) return;
    setMediaError(null);
    setDeletingMediaId(id);
    try {
      const deleteResult = await safeFetchJson<{ success?: boolean; error?: string }>(`/api/bots/${botId}/media?mediaId=${id}`, {
        method: "DELETE",
      });
      if (!deleteResult.ok) {
        setMediaError(deleteResult.error || "Couldn't remove that.");
        return;
      }
      await onReload();
    } finally {
      setDeletingMediaId(null);
    }
  };

  const addSong = async () => {
    const file = songFileInputRef.current?.files?.[0];
    if (!file) return;
    setSongUploading(true);
    setSongError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (songTitle.trim()) formData.append("title", songTitle.trim());
      const result = await safeFetchJson<{ song?: Song; error?: string }>(`/api/bots/${botId}/songs`, {
        method: "POST",
        body: formData,
      });
      if (!result.ok) throw new Error(result.error || "Upload failed.");
      setSongTitle("");
      setSongFileName("");
      if (songFileInputRef.current) songFileInputRef.current.value = "";
      await onReloadSongs();
    } catch (error) {
      setSongError(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setSongUploading(false);
    }
  };

  const deleteSong = async (id: string) => {
    if (deletingSongId) return;
    setSongError(null);
    setDeletingSongId(id);
    try {
      const deleteResult = await safeFetchJson<{ success?: boolean; error?: string }>(`/api/bots/${botId}/songs?songId=${id}`, {
        method: "DELETE",
      });
      if (!deleteResult.ok) {
        setSongError(deleteResult.error || "Couldn't remove that.");
        return;
      }
      await onReloadSongs();
    } finally {
      setDeletingSongId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-canvas p-4 text-sm">
        <p className="font-medium text-ink">Upload your own images or clips</p>
        <p className="mt-1 text-xs text-ink-dim">
          The channel uses these to add variety - it&apos;ll still find and create content on its own even without any.
        </p>
        {mediaError && <p className="mt-2 text-xs text-alert">{mediaError}</p>}
      </div>
      <div className="grid gap-2 md:grid-cols-4">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Media URL (optional)" className="input md:col-span-2" />
        <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="What's in it" className="input" />
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma, separated" className="input" />
        <select value={type} onChange={(e) => setType(e.target.value as "image" | "video")} className="input">
          <option value="image">Image</option>
          <option value="video">Video</option>
        </select>
        <input ref={fileInputRef} type="file" onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")} className="input md:col-span-2" />
        <button onClick={addMedia} disabled={uploading} className="btn-primary">
          {uploading ? "Uploading…" : "Add"}
        </button>
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        {media.map((m) => (
          <div key={m.id} className="rounded-lg border border-border bg-canvas p-3">
            <p className="truncate font-data text-[11px] text-ink-dim">{m.public_url || m.storage_path}</p>
            <p className="mt-1 text-sm text-ink">{m.media_context_caption}</p>
            <p className="text-xs text-ink-dim">#{m.tags.join(" #")}</p>
            <button onClick={() => deleteMedia(m.id)} disabled={deletingMediaId === m.id} className="mt-2 text-xs text-alert hover:underline disabled:no-underline">
              {deletingMediaId === m.id ? "Removing…" : "Remove"}
            </button>
          </div>
        ))}
        {!media.length && <p className="text-sm text-ink-dim">No media yet.</p>}
      </div>

      <div className="rounded-xl border border-border bg-canvas p-4 text-sm">
        <p className="font-medium text-ink">Upload soundtracks</p>
        <p className="mt-1 text-xs text-ink-dim">
          Add your own songs to this channel&apos;s music vault - mp3, wav, m4a, aac, ogg, flac, mp4 and webm are all fine.
          Leave the name blank to keep the file&apos;s own name.
        </p>
        {songError && <p className="mt-2 text-xs text-alert">{songError}</p>}
      </div>
      <div className="grid gap-2 md:grid-cols-4">
        <input value={songTitle} onChange={(e) => setSongTitle(e.target.value)} placeholder="Song name (optional)" className="input md:col-span-2" />
        <label className="btn-secondary flex cursor-pointer items-center justify-center text-center md:col-span-2">
          {songFileName || "Choose audio file"}
          <input
            ref={songFileInputRef}
            type="file"
            accept=".mp3,.wav,.m4a,.aac,.ogg,.flac,.mp4,.webm,audio/*"
            onChange={(e) => setSongFileName(e.target.files?.[0]?.name ?? "")}
            className="hidden"
          />
        </label>
        <button onClick={addSong} disabled={songUploading || !songFileName} className="btn-primary md:col-span-4">
          {songUploading ? "Uploading…" : "Add song"}
        </button>
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        {songs.map((song) => (
          <div key={song.id} className="rounded-lg border border-border bg-canvas p-3">
            <p className="truncate text-sm text-ink">{song.title}</p>
            <p className="text-xs text-ink-dim">
              {song.duration_seconds ? `${Math.round(song.duration_seconds)}s` : "Unknown length"} · {song.mood ?? "neutral"}
            </p>
            <button onClick={() => deleteSong(song.id)} disabled={deletingSongId === song.id} className="mt-2 text-xs text-alert hover:underline disabled:no-underline">
              {deletingSongId === song.id ? "Removing…" : "Remove"}
            </button>
          </div>
        ))}
        {!songs.length && <p className="text-sm text-ink-dim">No uploaded songs yet.</p>}
      </div>
    </div>
  );
}