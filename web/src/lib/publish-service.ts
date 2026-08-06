import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { ARTIST_CONTEXT } from "@/lib/artist";
import { getApiKeysBySlot, getGeminiKeysForBot } from "@/lib/config";
import { GeminiClient } from "@/lib/gemini/client";
import { XenrioClient } from "@/lib/xenrio/client";
import { getPostMediaUrl } from "@/lib/media";
import { pickSongForBot } from "@/lib/song-catalog";
import { renderMediaWithSoundtrack } from "@/lib/media-render";
import { processVideoForPublish } from "@/lib/video-pipeline";
import { prepareMemeImageForPublish } from "@/lib/meme-image";
import { prepareGenericImageForPublish } from "@/lib/image-prepare";
import { isFocusAligned, isKnownWrapperSource } from "@/lib/content-guard";
import { createPublishApiError, createPublishApiResult, type PublishApiResult } from "@/lib/publish-response";
import { listPlatformAccounts } from "@/lib/platform-accounts";
import type { XenrioPublishTarget } from "@/lib/xenrio/client";
import type { ConnectablePlatform } from "@/types/app";

type BotRow = Database["public"]["Tables"]["bots"]["Row"];

/**
 * Selects the next eligible queued/ready item and publishes it to Zernio for the
 * given bot. Shared by the manual "Publish if eligible" route and the autonomous
 * automation loop so both go through the exact same meme/video/music pipeline.
 * Assumes the caller has already confirmed the bot is eligible to post right now.
 */
export async function publishNextQueuedItem(
  supabase: SupabaseClient,
  bot: BotRow,
  options?: { preferredItemId?: string; targetPlatforms?: ConnectablePlatform[] },
): Promise<PublishApiResult> {
  const id = bot.id;
  const userId = bot.user_id;

  const noRepeatMediaPosts = Math.max(1, Number(process.env.NO_REPEAT_MEDIA_WINDOW_POSTS ?? 5));
  const noRepeatSongPosts = Math.max(1, Number(process.env.NO_REPEAT_SONG_WINDOW_POSTS ?? 4));
  const historyWindow = Math.max(noRepeatMediaPosts, noRepeatSongPosts, 12);

  const { data: recentPostedRaw } = await supabase
    .from("content_queue")
    .select("media_asset_id,metadata,published_at")
    .eq("bot_id", id)
    .eq("status", "posted")
    .order("published_at", { ascending: false })
    .limit(historyWindow);

  const recentPosted = (recentPostedRaw ?? []) as Array<{
    media_asset_id: string | null;
    metadata: unknown;
    published_at: string | null;
  }>;

  const blockedMediaAssetIds = new Set(
    recentPosted.slice(0, noRepeatMediaPosts).map((row) => row.media_asset_id).filter((value): value is string => Boolean(value)),
  );

  const recentSongIds = recentPosted
    .slice(0, noRepeatSongPosts)
    .map((row) => {
      const metadata = row.metadata;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
      const selectedSong = (metadata as Record<string, unknown>).selected_song;
      if (!selectedSong || typeof selectedSong !== "object" || Array.isArray(selectedSong)) return null;
      const songId = (selectedSong as Record<string, unknown>).id;
      return typeof songId === "string" ? songId : null;
    })
    .filter((value): value is string => Boolean(value));

  const { data: queuedItemsRaw, error: queueError } = await supabase
    .from("content_queue")
    .select("*")
    .eq("bot_id", id)
    .in("status", ["queued", "ready"])
    .order("created_at", { ascending: true })
    .limit(20);

  const queuedItems = (queuedItemsRaw ?? []) as Array<Database["public"]["Tables"]["content_queue"]["Row"]>;
  const eligibleCandidates: Array<Database["public"]["Tables"]["content_queue"]["Row"]> = [];

  for (const candidate of queuedItems) {
    const metadata =
      candidate.metadata && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata)
        ? (candidate.metadata as Record<string, unknown>)
        : {};
    const sourceUrl = typeof metadata.source_url === "string" ? metadata.source_url : null;
    const mediaUrlMeta = typeof metadata.media_url === "string" ? metadata.media_url : null;

    if (isKnownWrapperSource(sourceUrl) || isKnownWrapperSource(mediaUrlMeta)) {
      await supabase
        .from("content_queue")
        .update({
          status: "cancelled",
          error_message: "Auto-cancelled: known wrapper source host not suitable for direct publishing",
        })
        .eq("id", candidate.id);
      continue;
    }

    const aligned = isFocusAligned(bot.content_target, {
      title: typeof metadata.discovery_title === "string" ? metadata.discovery_title : null,
      description: typeof metadata.discovery_description === "string" ? metadata.discovery_description : null,
      source: typeof metadata.source === "string" ? metadata.source : null,
      sourceUrl,
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter((v): v is string => typeof v === "string") : null,
    });

    if (!aligned) {
      await supabase
        .from("content_queue")
        .update({
          status: "cancelled",
          error_message: `Auto-cancelled: out of selected focus (${bot.content_target})`,
        })
        .eq("id", candidate.id);
      continue;
    }

    eligibleCandidates.push(candidate);
  }

  const nonRepeatedCandidate = eligibleCandidates.find(
    (candidate) => !candidate.media_asset_id || !blockedMediaAssetIds.has(candidate.media_asset_id),
  );
  // A manual pick (from the meme-vault review-and-publish screen) is a
  // deliberate human decision — skip the generic oldest-first candidate
  // selection and its auto-cancel checks entirely, and just publish exactly
  // the item the caller asked for.
  let item: Database["public"]["Tables"]["content_queue"]["Row"] | null = nonRepeatedCandidate ?? eligibleCandidates[0] ?? null;
  if (options?.preferredItemId) {
    const { data: preferredItem } = await supabase
      .from("content_queue")
      .select("*")
      .eq("id", options.preferredItemId)
      .eq("bot_id", id)
      .in("status", ["queued", "ready"])
      .single();
    item = (preferredItem as Database["public"]["Tables"]["content_queue"]["Row"] | null) ?? null;
  }

  if (queueError || !item) {
    return createPublishApiError("No queued item available", 404);
  }

  // Claim the item atomically before any expensive processing starts. The
  // automation loop and the manual "Publish now" button both call this
  // function and can overlap (one run's Gemini/ffmpeg work routinely takes
  // minutes, far longer than either trigger interval) — without this,
  // multiple callers all pick the same still-"queued" row and each publish
  // it to Instagram separately. This update only succeeds for whichever
  // caller gets there first; every later caller sees zero rows affected and
  // backs off instead of duplicating the post.
  const { data: claimedRows, error: claimError } = await supabase
    .from("content_queue")
    .update({ status: "publishing" })
    .eq("id", item.id)
    .in("status", ["queued", "ready"])
    .select("id");

  if (claimError) {
    return createPublishApiError(`Could not claim queue item: ${claimError.message}`);
  }
  if (!claimedRows || claimedRows.length === 0) {
    return createPublishApiError("Item already claimed by another publish run", 409);
  }

  const { xenrio } = getApiKeysBySlot(bot.api_slot);
  if (!xenrio) {
    return createPublishApiError("Xenrio API key not configured for this slot");
  }

  const geminiClient = new GeminiClient(getGeminiKeysForBot(bot.api_slot));
  const xenrioClient = new XenrioClient(xenrio);

  let mediaUrl: string | undefined;
  let mediaType: "image" | "video" | undefined;
  let tags: string[] = [];
  let mediaUsageCount = 0;

  if (item.media_asset_id) {
    const { data: media } = await supabase
      .from("media_assets")
      .select("*")
      .eq("id", item.media_asset_id)
      .single();

    mediaUrl = media?.public_url ?? undefined;
    if (media?.storage_path) {
      const { data: signed, error: signedError } = await supabase.storage
        .from("bot-media")
        .createSignedUrl(media.storage_path, 60 * 60);
      if (!signedError && signed?.signedUrl) {
        mediaUrl = signed.signedUrl;
      } else if (signedError) {
        console.warn(`[${id}] Could not create signed media URL: ${signedError.message}`);
      }
    }
    mediaType = media?.media_type ?? undefined;
    tags = media?.tags ?? [];
    mediaUsageCount = media?.usage_count ?? 0;
  }

  const resolvedMediaUrl = getPostMediaUrl(item.metadata as Record<string, unknown> | null, mediaUrl);
  const isMemePost = bot.content_target === "memes";
  const isMemeImagePost = isMemePost && mediaType === "image";

  const accountId = bot.zernio_account_id ?? bot.instagram_business_id;
  const platformAccounts = await listPlatformAccounts(supabase, id);
  let connectedTargets: XenrioPublishTarget[] = platformAccounts
    .filter((account) => account.connection_status === "connected")
    .map((account) => ({ platform: account.platform, accountId: account.zernio_account_id }));

  // Back-compat: bots connected before multi-platform support only have the
  // legacy single Instagram account column, not a bot_platform_accounts row yet.
  if (connectedTargets.length === 0 && accountId) {
    connectedTargets.push({ platform: "instagram", accountId });
  }

  // Manual publish flows let the user pick which connected platforms a
  // specific item goes to (rather than always posting to every one).
  if (options?.targetPlatforms && options.targetPlatforms.length > 0) {
    const requested = new Set(options.targetPlatforms);
    connectedTargets = connectedTargets.filter((target) => requested.has(target.platform));
  }

  if (connectedTargets.length === 0) {
    await supabase
      .from("content_queue")
      .update({
        status: "failed",
        error_message: "No connected platform accounts synced from Zernio",
      })
      .eq("id", item.id);

    return createPublishApiError("No connected platform accounts synced from Zernio");
  }

  if (!resolvedMediaUrl) {
    await supabase
      .from("content_queue")
      .update({
        status: "failed",
        error_message: "No media URL available for publishing",
      })
      .eq("id", item.id);

    return createPublishApiError("Media URL required to publish", 400);
  }

  if (!bot.timezone) {
    console.warn(`[${id}] Bot timezone missing. Falling back to UTC.`);
  }

  const baseMetadata =
    item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? (item.metadata as Record<string, unknown>)
      : {};

  let publishMediaUrl = resolvedMediaUrl;
  let publishMediaType: "image" | "video" | undefined = mediaType;
  let memeCaption: string | null = null;
  let enrichedMetadata: Record<string, unknown> = {
    ...baseMetadata,
  };

  if (isMemeImagePost && publishMediaUrl) {
    try {
      const memePreparation = await prepareMemeImageForPublish({
        supabase,
        userId,
        botId: id,
        queueItemId: item.id,
        mediaUrl: publishMediaUrl,
        geminiClient,
        sourceTitle: typeof baseMetadata.discovery_title === "string" ? baseMetadata.discovery_title : null,
        sourceDescription: typeof baseMetadata.discovery_description === "string" ? baseMetadata.discovery_description : null,
        mediaTags: tags,
      });

      publishMediaUrl = memePreparation.publishMediaUrl;
      publishMediaType = "image";
      memeCaption = memePreparation.analysis.suggestedCaption || null;
      tags = Array.from(new Set([...tags, ...memePreparation.analysis.hashtags.map((tag) => tag.replace(/^#/, ""))]));
      enrichedMetadata = {
        ...enrichedMetadata,
        meme_analysis: {
          has_readable_text: memePreparation.analysis.hasReadableText,
          extracted_text: memePreparation.analysis.extractedText,
          is_meme: memePreparation.analysis.isMeme,
          confidence: memePreparation.analysis.confidence,
          visual_context: memePreparation.analysis.visualContext,
          suggested_overlay_text: memePreparation.analysis.suggestedOverlayText,
          hashtags: memePreparation.analysis.hashtags,
          overlay_applied: memePreparation.overlayApplied,
          prepared_media_storage_path: memePreparation.renderedStoragePath,
        },
      };
    } catch (memeError) {
      const message = memeError instanceof Error ? memeError.message : "Unknown meme image preparation error";
      await supabase
        .from("content_queue")
        .update({
          status: "cancelled",
          error_message: `Auto-cancelled: meme image missing readable text or render failed (${message})`,
        })
        .eq("id", item.id);
      return createPublishApiError(`Meme image rejected: ${message}`);
    }
  }

  if (!isMemePost && mediaType === "image" && publishMediaUrl) {
    try {
      const prepared = await prepareGenericImageForPublish({
        supabase,
        userId,
        botId: id,
        queueItemId: item.id,
        mediaUrl: publishMediaUrl,
      });
      publishMediaUrl = prepared.publishMediaUrl;
      publishMediaType = "image";
      enrichedMetadata = {
        ...enrichedMetadata,
        feed_image_prepared_storage_path: prepared.storagePath,
      };
    } catch (imageError) {
      // Not a hard-reject like meme prep — a scraped image failing to
      // reformat shouldn't lose the whole post, just fall back to original.
      console.warn(`[${id}] Generic feed image prep failed for queue item ${item.id}: ${imageError instanceof Error ? imageError.message : String(imageError)}`);
    }
  }

  let videoContextSummary: string | null = null;
  let videoHashtags: string[] = [];
  let videoManualReview = false;
  let processedVideoUrl: string | null = null;
  let processedVideoStoragePath: string | null = null;

  if (resolvedMediaUrl && mediaType === "video") {
    try {
      const processedVideo = await processVideoForPublish({
        supabase,
        userId,
        botId: id,
        queueItemId: item.id,
        mediaUrl: resolvedMediaUrl,
        geminiClient,
        persona: bot.persona,
        additionalPersona: bot.additional_persona,
        contentTarget: bot.content_target,
        location: [bot.city, bot.country].filter(Boolean).join(", "),
        songs: ARTIST_CONTEXT.songs,
        artistHandle: ARTIST_CONTEXT.instagramHandle,
      });

      processedVideoUrl = processedVideo.publishMediaUrl;
      processedVideoStoragePath = processedVideo.renderedStoragePath;
      mediaType = "video";
      videoContextSummary = processedVideo.analysis.contextSummary;
      videoHashtags = processedVideo.analysis.hashtags;
      videoManualReview = processedVideo.analysis.needsManualReview;
    } catch (videoPipelineError) {
      const message = videoPipelineError instanceof Error ? videoPipelineError.message : "Unknown video pipeline error";
      console.warn(`[${id}] Video pipeline failed, falling back to direct publish: ${message}`);
    }
  }

  // A manual pick from the meme-vault review-and-publish screen already has
  // a human-approved caption — reuse it instead of the meme-path's normal
  // re-generate-every-time behavior.
  const isManualSelection = baseMetadata.manual_selection === true;
  const reusableCaption =
    !isMemePost || isManualSelection
      ? typeof item.generated_caption === "string" && item.generated_caption.trim()
        ? item.generated_caption
        : null
      : null;
  const discoveryTitle = typeof baseMetadata.discovery_title === "string" ? baseMetadata.discovery_title : null;
  const discoveryDescription = typeof baseMetadata.discovery_description === "string" ? baseMetadata.discovery_description : null;
  const extractedImageText = typeof baseMetadata.extracted_image_text === "string" ? baseMetadata.extracted_image_text : null;
  const sourceContext = extractedImageText
    ? `Image text: "${extractedImageText}" | Post: ${discoveryTitle ?? ""}`
    : discoveryTitle || discoveryDescription || null;
  const caption =
    reusableCaption ??
    memeCaption ??
    (await geminiClient.generateCaption({
      artist: ARTIST_CONTEXT.name,
      songs: ARTIST_CONTEXT.songs,
      persona: bot.persona,
      additionalPersona: bot.additional_persona,
      contentTarget: bot.content_target,
      location: [bot.city, bot.country].filter(Boolean).join(", "),
      mediaTags: tags,
      sourceContext,
    }));

  const contextCaption =
    mediaType === "video" && videoContextSummary
      ? [
          caption,
          videoManualReview ? "Manual review recommended: low-confidence context." : null,
          videoHashtags.length > 0 ? videoHashtags.join(" ") : null,
        ]
          .filter(Boolean)
          .join("\n\n")
      : caption;

  // The artist's own selected song is the whole point of the soundtrack
  // feature — always attach it, for non-meme AND meme content alike, since
  // neither has real native audio worth preserving. TikTok and Facebook
  // videos are the only exception: they're the artist's own posts and
  // already have the real song baked in as the native audio, so overlaying a
  // separately-picked song would replace it with a possibly different track.
  const sourceUrlForAudioCheck = typeof baseMetadata.source_url === "string" ? baseMetadata.source_url : "";
  const hasNativeAudioAlready =
    mediaType === "video" &&
    (sourceUrlForAudioCheck.toLowerCase().includes("tiktok.com") || sourceUrlForAudioCheck.toLowerCase().includes("facebook.com"));

  // Meme vault videos: 4 out of every 5 get a soundtrack, the 5th keeps its
  // native sound — a deliberate ratio, not the TikTok/Facebook exception
  // above. Counted off real posted history (not an in-memory counter) so it
  // survives dev server restarts and resumes the cycle correctly.
  let isFifthMemeVideoInCycle = false;
  if (isMemePost && mediaType === "video" && !hasNativeAudioAlready) {
    const { count: postedMemeVideoCount } = await supabase
      .from("content_queue")
      .select("id", { count: "exact", head: true })
      .eq("bot_id", id)
      .eq("status", "posted")
      .eq("metadata->>media_type", "video");
    const upcomingMemeVideoNumber = (postedMemeVideoCount ?? 0) + 1;
    isFifthMemeVideoInCycle = upcomingMemeVideoNumber % 5 === 0;
  }

  const shouldConsiderMusic = !hasNativeAudioAlready && !isFifthMemeVideoInCycle;

  // A manual pick can name an exact song (or explicitly opt out) instead of
  // the automatic mood/ratio-based picker.
  const manualSongId = typeof baseMetadata.manual_song_id === "string" ? baseMetadata.manual_song_id : null;
  const manualNoSong = baseMetadata.manual_no_song === true;

  let selectedSong: Awaited<ReturnType<typeof pickSongForBot>> = null;
  if (manualNoSong) {
    selectedSong = null;
  } else if (manualSongId) {
    const { data: manualSong } = await supabase.from("songs").select("*").eq("id", manualSongId).single();
    selectedSong = manualSong ?? null;
  } else if (shouldConsiderMusic) {
    selectedSong = await pickSongForBot(supabase, id, bot.content_target, { excludeSongIds: recentSongIds });
  }
  const soundtrackLine = selectedSong
    ? `Soundtrack: ${selectedSong.title} - ${selectedSong.artist ?? ARTIST_CONTEXT.name}`
    : null;
  let finalCaption = [contextCaption, soundtrackLine, `@${ARTIST_CONTEXT.instagramHandle}`]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 2200);


  const recentCaptionSet = new Set(
    recentPosted
      .map((row) => {
        const metadata = row.metadata;
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "";
        const v = (metadata as Record<string, unknown>).published_caption;
        return typeof v === "string" ? v.trim().toLowerCase() : "";
      })
      .filter(Boolean),
  );

  if (recentCaptionSet.has(finalCaption.trim().toLowerCase())) {
    const metadata =
      item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
        ? (item.metadata as Record<string, unknown>)
        : {};
    const title = typeof metadata.discovery_title === "string" ? metadata.discovery_title : "fresh context";
    finalCaption = `${finalCaption}\n\nContext cut: ${title.slice(0, 80)}`.slice(0, 2200);
  }
  enrichedMetadata = {
    ...enrichedMetadata,
    selected_song: selectedSong
      ? {
          id: selectedSong.id,
          title: selectedSong.title,
          artist: selectedSong.artist,
          mood: selectedSong.mood,
          storage_path: selectedSong.storage_path,
          duration_seconds: selectedSong.duration_seconds,
        }
      : null,
    video_context_summary: videoContextSummary,
    video_hashtags: videoHashtags,
    video_needs_manual_review: videoManualReview,
    video_prepared_media_storage_path: processedVideoStoragePath,
    published_caption: finalCaption,
  };

  publishMediaUrl = processedVideoUrl ?? publishMediaUrl;
  publishMediaType = processedVideoUrl ? "video" : publishMediaType;

  if (selectedSong && publishMediaUrl) {
    const { data: songSigned, error: songSignedError } = await supabase.storage
      .from("music")
      .createSignedUrl(selectedSong.storage_path, 60 * 60);

    if (songSignedError || !songSigned?.signedUrl) {
      console.warn(`[${id}] Could not sign selected song URL: ${songSignedError?.message ?? "unknown error"}`);
    } else {
      const renderSourceType: "image" | "video" = mediaType === "video" ? "video" : "image";
      try {
        const rendered = await renderMediaWithSoundtrack({
          supabase,
          userId,
          botId: id,
          queueItemId: item.id,
          sourceMediaUrl: publishMediaUrl,
          sourceMediaType: renderSourceType,
          songSignedUrl: songSigned.signedUrl,
          songDurationSeconds: selectedSong.duration_seconds,
          maxDurationSeconds: 20,
        });

        publishMediaUrl = rendered.signedUrl;
        publishMediaType = "video";
        enrichedMetadata = {
          ...enrichedMetadata,
          rendered_media: {
            storage_path: rendered.storagePath,
            media_type: "video",
            audio_start_seconds: rendered.audioStartSeconds,
            audio_duration_seconds: rendered.audioDurationSeconds,
          },
        };
      } catch (renderError) {
        const message = renderError instanceof Error ? renderError.message : "Unknown render error";
        console.warn(`[${id}] Audio render skipped: ${message}`);
        enrichedMetadata = {
          ...enrichedMetadata,
          rendered_media_error: message,
        };
      }
    }
  }

  const { error: queueUpdateError } = await supabase
    .from("content_queue")
    .update({ status: "publishing", generated_caption: finalCaption, metadata: enrichedMetadata })
    .eq("id", item.id);

  if (queueUpdateError) throw queueUpdateError;

  console.log(`[${id}] Publishing to Zernio`, {
    targets: connectedTargets,
    surface: item.surface,
    timezone: bot.timezone || "UTC",
    mediaUrl: publishMediaUrl,
    captionLength: finalCaption.length,
  });

  let publishedPostId: string;
  let publishWarning: string | null = null;
  try {
    const published = await xenrioClient.publish({
      targets: connectedTargets,
      caption: finalCaption,
      surface: item.surface,
      mediaUrl: publishMediaUrl,
      mediaType: publishMediaType,
      timezone: bot.timezone || "UTC",
    });

    console.log(`[${id}] Xenrio response`, published);
    publishedPostId = published.postId;

    const warnings: string[] = [];
    if (published.skipped.length > 0) {
      warnings.push(`Skipped (rate-limited): ${published.skipped.map((s) => `${s.platform} - ${s.reason}`).join("; ")}`);
    }
    if (published.failedPlatforms.length > 0) {
      warnings.push(`Failed to post: ${published.failedPlatforms.map((p) => `${p.platform} - ${p.error}`).join("; ")}`);
    }
    if (warnings.length > 0) {
      publishWarning = warnings.join(" | ");
      console.warn(`[${id}] Partial publish failure: ${publishWarning}`);
    }
  } catch (publishError) {
    const message = publishError instanceof Error ? publishError.message : "Unknown publish error";
    console.error(`[${id}] Xenrio publish failed:`, message);

    // Instagram itself flagged the account and requires a manual security
    // check + reconnect — retrying won't help, and letting automation keep
    // hammering a dead account wastes discovery/Gemini calls every cycle.
    // Flip the bot to disconnected so it stops trying until the user
    // reconnects, and the dashboard immediately shows it needs attention.
    const isAccountDisconnected = message.includes("ACCOUNT_DISCONNECTED") || message.toLowerCase().includes("disconnected and cannot be posted");
    const queueErrorMessage = isAccountDisconnected
      ? "Instagram disconnected this account for a security check. Log in at instagram.com, clear the check, then reconnect Instagram here."
      : `Zernio publish failed: ${message}`;

    const { error: failedUpdateError } = await supabase
      .from("content_queue")
      .update({
        status: "failed",
        error_message: queueErrorMessage,
      })
      .eq("id", item.id);

    if (failedUpdateError) {
      console.error(`[${id}] Failed to persist publish failure to queue:`, failedUpdateError);
    }

    if (isAccountDisconnected) {
      const { error: botUpdateError } = await supabase
        .from("bots")
        .update({ connection_status: "disconnected" })
        .eq("id", id);
      if (botUpdateError) {
        console.error(`[${id}] Failed to mark bot as disconnected:`, botUpdateError);
      }
    }

    const lower = message.toLowerCase();
    const status = isAccountDisconnected
      ? 401
      : lower.includes("require media") ||
          lower.includes("media content") ||
          lower.includes("invalid media")
        ? 400
        : lower.includes("401") || lower.includes("403")
          ? 401
          : 502;

    return createPublishApiError(queueErrorMessage, status);
  }

  const { error: updateError } = await supabase
    .from("content_queue")
    .update({
      status: "posted",
      generated_caption: finalCaption,
      provider_post_id: publishedPostId,
      published_at: new Date().toISOString(),
      error_message: publishWarning,
      metadata: enrichedMetadata,
    })
    .eq("id", item.id);

  if (updateError) {
    console.error(`[${id}] Final queue update failed:`, updateError);
    throw updateError;
  }

  await supabase.from("bots").update({ last_posted_at: new Date().toISOString() }).eq("id", id);

  if (item.media_asset_id) {
    await supabase
      .from("media_assets")
      .update({ is_used: true, usage_count: mediaUsageCount + 1 })
      .eq("id", item.media_asset_id);
  }

  return createPublishApiResult(true, { postId: publishedPostId, warning: publishWarning ?? undefined });
}
