import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { publishNextQueuedItem } from "@/lib/publish-service";
import type { ConnectablePlatform } from "@/types/app";

type BotRow = Database["public"]["Tables"]["bots"]["Row"];

export interface ManualQueueResult {
  queued: boolean;
  published: boolean;
  error?: string;
}

interface QueueAndPublishOptions {
  botId: string;
  mediaAssetId: string;
  mediaType: "image" | "video";
  caption: string;
  tags: string[];
  songId: string | null;
  noSong: boolean;
  source: string;
  discoveryTitle?: string | null;
  discoveryDescription?: string | null;
  extraMetadata?: Record<string, unknown>;
  targetPlatforms?: ConnectablePlatform[];
}

/**
 * Shared by the manual meme-vault publish flow and the "Live" tab publish
 * flow: inserts a content_queue row pointing at an already-created
 * media_assets row, then immediately publishes that exact row. Kept as one
 * helper so both flows stay in sync (same metadata shape the publish
 * pipeline's manual-selection overrides look for — see publish-service.ts).
 */
export async function queueAndPublishManualItem(
  supabase: SupabaseClient,
  bot: BotRow,
  options: QueueAndPublishOptions,
): Promise<ManualQueueResult> {
  const result: ManualQueueResult = { queued: false, published: false };

  const { data: queueRow, error: queueError } = await supabase
    .from("content_queue")
    .insert({
      bot_id: options.botId,
      media_asset_id: options.mediaAssetId,
      status: "queued",
      surface: options.mediaType === "video" ? "reel" : "feed",
      generated_caption: options.caption?.trim() || null,
      metadata: {
        source: options.source,
        discovery_title: options.discoveryTitle ?? null,
        discovery_description: options.discoveryDescription ?? null,
        media_type: options.mediaType,
        tags: options.tags,
        manual_selection: true,
        manual_song_id: options.noSong ? null : options.songId,
        manual_no_song: Boolean(options.noSong),
        ...options.extraMetadata,
      },
    })
    .select("id")
    .single();
  if (queueError || !queueRow?.id) {
    result.error = queueError?.message ?? "Could not queue item";
    return result;
  }

  result.queued = true;

  const publishResult = await publishNextQueuedItem(supabase, bot, {
    preferredItemId: queueRow.id,
    targetPlatforms: options.targetPlatforms,
  });
  result.published = Boolean(publishResult.body.success);
  if (!publishResult.body.success) {
    const bodyError = publishResult.body.error;
    const bodyReason = publishResult.body.reason;
    result.error =
      (typeof bodyError === "string" && bodyError) ||
      (typeof bodyReason === "string" && bodyReason) ||
      "Publish failed";
  }

  return result;
}
