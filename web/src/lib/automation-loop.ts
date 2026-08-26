import { isBotEligibleNow } from "@/lib/scheduler";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureDefaultPostingWindows } from "@/lib/posting-windows";
import { discoverAndQueueContent } from "@/lib/discovery-ingest";
import { publishNextQueuedItem } from "@/lib/publish-service";
import { tryAcquireAutomationLock, releaseAutomationLock } from "@/lib/automation-lock";
import type { Database } from "@/types/db";

const AUTO_LOOP_INTERVAL_MS = 60_000;
const globalState = globalThis as typeof globalThis & {
  __marathonAutomationLoopStarted?: boolean;
};

export async function runAutomationCycle() {
  // Discovery (Gemini + ffmpeg per item) routinely takes longer than the 60s
  // tick interval. Without this guard, overlapping ticks pile up concurrent
  // ffmpeg/Supabase requests against the same rows, causing spurious failures.
  if (!tryAcquireAutomationLock()) {
    console.log("[automation-loop] Skipping tick: previous cycle still running");
    return { processed: 0, published: 0, skipped: true };
  }

  try {
    // Service-role client: this loop runs on a timer with no logged-in request,
    // so there's no session cookie for a per-user client to read.
    const supabase = createAdminClient();
    const { data: bots, error: botError } = await supabase
      .from("bots")
      .select("*")
      .eq("is_active", true)
      .eq("is_demo", false)
      .eq("connection_status", "connected");

    if (botError) throw botError;

    console.log(`[automation-loop] tick: ${bots?.length ?? 0} active connected bot(s)`);

    let processed = 0;
    let published = 0;

    for (const bot of bots ?? []) {
      // Browser disconnects do not cancel an in-process publish, but a server
      // restart or terminated request can leave its durable queue item claimed
      // as publishing. Return only stale claims to queued work for retry.
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
      if (!eligibility.ok) {
        console.log(`[automation-loop] Bot ${bot.id} not eligible: ${eligibility.reason ?? "unknown"}`);
        continue;
      }

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
          console.log(`[automation-loop] Bot ${bot.id} discovery found nothing queueable this tick (${result.skipped} skipped)`);
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
          console.warn(`[automation-loop] Publish skipped for bot ${bot.id}: ${result.body.error ?? result.body.reason ?? "unknown"}`);
        }
      } catch (publishError) {
        console.error(`[automation-loop] Publish failed for bot ${bot.id}:`, publishError instanceof Error ? publishError.message : publishError);
      }
    }

    return { processed, published };
  } catch (error) {
    return { processed: 0, published: 0, error: error instanceof Error ? error.message : "Automation loop failed" };
  } finally {
    releaseAutomationLock();
  }
}

export function startAutomationLoop() {
  if (typeof window !== "undefined") return;
  if (globalState.__marathonAutomationLoopStarted) return;
  // Vercel has no ffmpeg/yt-dlp and no persistent process for setInterval to
  // live in — real automation runs on the local machine's server instead;
  // Vercel is UI-only, so skip starting a loop that could only ever fail here.
  if (process.env.VERCEL) return;

  globalState.__marathonAutomationLoopStarted = true;
  setInterval(() => {
    void runAutomationCycle();
  }, AUTO_LOOP_INTERVAL_MS);
}
