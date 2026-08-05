import { addMinutes, isAfter } from "date-fns";
import type { Database } from "@/types/db";

type Bot = Database["public"]["Tables"]["bots"]["Row"];
type QueueItem = Database["public"]["Tables"]["content_queue"]["Row"];
type PostingWindow = Database["public"]["Tables"]["bot_posting_windows"]["Row"];

export function getWeekdayInTz(date: Date, timeZone: string) {
  const str = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);

  const map: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };

  return map[str] ?? 1;
}

export function getLocalTimeString(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function isInsideWindow(timeHHMM: string, startHHMM: string, endHHMM: string) {
  return timeHHMM >= startHHMM && timeHHMM <= endHHMM;
}

export function isBotEligibleNow(
  bot: Bot,
  windows: PostingWindow[],
  postedToday: number,
  now = new Date(),
): { ok: boolean; reason?: string } {
  if (!bot.is_active) return { ok: false, reason: "Bot sleeping" };

  if (!bot.connection_status || bot.connection_status !== "connected") {
    return { ok: false, reason: "Bot not connected" };
  }

  if (postedToday >= bot.max_posts_per_day) {
    return { ok: false, reason: "Daily cap reached" };
  }

  if (bot.last_posted_at) {
    const nextAllowed = addMinutes(new Date(bot.last_posted_at), bot.cooldown_minutes);
    if (isAfter(nextAllowed, now)) {
      return { ok: false, reason: "Cooldown active" };
    }
  }

  return { ok: true };
}

export function nextRetryTime(retryCount: number) {
  const waitMinutes = Math.min(60, Math.max(2, 2 ** retryCount));
  return addMinutes(new Date(), waitMinutes).toISOString();
}

export function queueHasRecentDuplicate(queue: QueueItem[], caption: string) {
  const normalized = caption.trim().toLowerCase();
  return queue.some((q) => (q.generated_caption ?? "").trim().toLowerCase() === normalized);
}
