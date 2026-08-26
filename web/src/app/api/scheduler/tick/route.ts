import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isBotEligibleNow } from "@/lib/scheduler";
import { ensureDefaultPostingWindows } from "@/lib/posting-windows";
import { discoverAndQueueContent } from "@/lib/discovery-ingest";
import { publishNextQueuedItem } from "@/lib/publish-service";
import { tryAcquireAutomationLock, releaseAutomationLock } from "@/lib/automation-lock";
import type { Database } from "@/types/db";

async function runSchedulerTick() {
  if (!tryAcquireAutomationLock()) {
    return NextResponse.json({ processed: 0, published: 0, skipped: true, reason: "Another automation cycle is already running" });
  }

  try {
    // Service-role client: this endpoint is meant to be hit by an external cron
    // trigger, not a logged-in browser session.
    const supabase = createAdminClient();

    const { data: bots, error: botError } = await supabase
      .from("bots")
      .select("*")
      .eq("is_active", true)
      .eq("is_demo", false)
      .eq("connection_status", "connected");

    if (botError) throw botError;

    let processed = 0;
    let published = 0;

    for (const bot of bots ?? []) {
      const stalePublishingThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await supabase
        .from("content_queue")
        .update({ status: "queued", error_message: "Recovered after an interrupted publish attempt; retrying automatically." })
        .eq("bot_id", bot.id)
        .eq("status", "publishing")
        .lt("updated_at", stalePublishingThreshold);

      const { data: windows } = await supabase.from("bot_posting_windows").select("*").eq("bot_id", bot.id);
      const postingWindows = windows && windows.length > 0 ? windows : await ensureDefaultPostingWindows(supabase, bot.id);
      const now = new Date();
      const dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);

      const { count } = await supabase
        .from("content_queue")
        .select("id", { count: "exact", head: true })
        .eq("bot_id", bot.id)
        .eq("status", "posted")
        .gte("published_at", dayStart.toISOString());

      const eligibility = isBotEligibleNow(
        bot,
        postingWindows as Database["public"]["Tables"]["bot_posting_windows"]["Row"][],
        count ?? 0,
        now,
      );
      if (!eligibility.ok) continue;

      const { data: nextItem } = await supabase
        .from("content_queue")
        .select("*")
        .eq("bot_id", bot.id)
        .eq("status", "queued")
        .limit(1)
        .single();

      if (!nextItem) {
        // Always go through the same focus-aligned / meme-verified pipeline as
        // the manual discover button — never queue a random unrelated media
        // asset just to have something to post.
        const result = await discoverAndQueueContent(supabase, supabase, bot, { limit: 20, userId: bot.user_id });
        if (result.queued === 0) {
          console.log(`[scheduler/tick] Bot ${bot.id} discovery found nothing queueable this tick (${result.skipped} skipped)`);
          continue;
        }
      }

      const { data: readyItem } = await supabase
        .from("content_queue")
        .select("id")
        .eq("bot_id", bot.id)
        .eq("status", "queued")
        .limit(1)
        .single();

      if (!readyItem) continue;

      await supabase
        .from("content_queue")
        .update({ status: "ready", scheduled_for: new Date().toISOString() })
        .eq("id", readyItem.id);

      processed += 1;

      try {
        const result = await publishNextQueuedItem(supabase, bot);
        if (result.body.success) {
          published += 1;
        } else {
          console.warn(`[scheduler/tick] Publish skipped for bot ${bot.id}: ${result.body.error ?? result.body.reason ?? "unknown"}`);
        }
      } catch (publishError) {
        console.error(`[scheduler/tick] Publish failed for bot ${bot.id}:`, publishError instanceof Error ? publishError.message : publishError);
      }
    }

    return NextResponse.json({ processed, published });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Scheduler failed" }, { status: 500 });
  } finally {
    releaseAutomationLock();
  }
}

export async function POST(request: Request) {
  const background = new URL(request.url).searchParams.get("background") === "1";
  if (background) {
    void runSchedulerTick();
    return NextResponse.json({ accepted: true, message: "Automation started. The queue will update as work completes." }, { status: 202 });
  }
  return runSchedulerTick();
}
