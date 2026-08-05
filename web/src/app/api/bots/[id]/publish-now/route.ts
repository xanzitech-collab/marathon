import { requireUser } from "@/lib/auth";
import { isBotEligibleNow } from "@/lib/scheduler";
import { ensureDefaultPostingWindows } from "@/lib/posting-windows";
import { publishNextQueuedItem } from "@/lib/publish-service";
import { createPublishApiError, createPublishApiResult, toNextResponse } from "@/lib/publish-response";
import type { Database } from "@/types/db";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (botError || !bot) throw new Error("Bot not found");

    const { data: windows } = await supabase.from("bot_posting_windows").select("*").eq("bot_id", id);
    const postingWindows = windows && windows.length > 0 ? windows : await ensureDefaultPostingWindows(supabase, id);

    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);

    const { count: postedToday } = await supabase
      .from("content_queue")
      .select("id", { count: "exact", head: true })
      .eq("bot_id", id)
      .eq("status", "posted")
      .gte("published_at", dayStart.toISOString());

    const elig = isBotEligibleNow(bot, postingWindows as Database["public"]["Tables"]["bot_posting_windows"]["Row"][], postedToday ?? 0, now);
    const requestUrl = new URL(request.url);
    const isDev = process.env.NODE_ENV !== "production";
    const devBypassCooldown =
      isDev &&
      requestUrl.searchParams.get("devBypassCooldown") === "1";
    const devBypassDailyCap =
      isDev &&
      requestUrl.searchParams.get("devBypassDailyCap") === "1";
    const devBypassAllLimits =
      isDev &&
      requestUrl.searchParams.get("devBypassLimits") === "1";
    const shouldBypassForReason = (reason?: string) => {
      if (!reason) return false;
      if (devBypassAllLimits) return reason === "Cooldown active" || reason === "Daily cap reached";
      if (reason === "Cooldown active" && devBypassCooldown) return true;
      if (reason === "Daily cap reached" && devBypassDailyCap) return true;
      return false;
    };

    if (!elig.ok) {
      if (shouldBypassForReason(elig.reason)) {
        console.warn(`[${id}] Development eligibility bypass applied for reason: ${elig.reason}.`);
      } else {
        return toNextResponse(createPublishApiResult(false, { skipped: true, reason: elig.reason ?? "Not eligible to publish right now" }));
      }
    }

    const result = await publishNextQueuedItem(supabase, bot);
    return toNextResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publish failed";
    console.error("Publish error:", message);
    return toNextResponse(createPublishApiError(message, 500));
  }
}

