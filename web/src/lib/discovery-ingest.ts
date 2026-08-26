import { promises as fs } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { ContentDiscoveryService } from "@/lib/content-discovery";
import { extractMediaFromUrl, validateMediaUrl, normalizeSourceUrl } from "@/lib/discovery-media";
import { isFocusAligned, isKnownWrapperSource, isKnownWrapperMediaResult } from "@/lib/content-guard";
import { GeminiClient } from "@/lib/gemini/client";
import { ARTIST_CONTEXT } from "@/lib/artist";
import { buildFallbackMemePlan, verifyAndClassifyMemeCandidate, type MemeVerificationResult } from "@/lib/meme-verifier";
import { renderJokeOntoImage, type RenderedMemeResult } from "@/lib/meme-canvas-render";
import { extractVideoKeyframe, renderJokeOntoVideo } from "@/lib/meme-video-render";
import { getGeminiKeysForBot } from "@/lib/config";

type BotRow = Database["public"]["Tables"]["bots"]["Row"];

export interface IngestResult {
  discovered: number;
  queued: number;
  skipped: number;
  debug: Array<Record<string, unknown>>;
}

function localMediaContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".mp4": return "video/mp4";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
    case ".m4v": return "video/x-m4v";
    default: return "image/jpeg";
  }
}

/**
 * Runs the full discovery -> focus-alignment -> meme verification/render ->
 * caption pipeline and queues the accepted items. This is the ONLY code path
 * that should ever add content_queue rows — every image/video that goes out
 * must be tied to the caption via real verification, never picked independently.
 * Shared by the manual discover route and the autonomous automation loop.
 */
export async function discoverAndQueueContent(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  bot: BotRow,
  options: { limit?: number; userId: string },
): Promise<IngestResult> {
  const id = bot.id;
  const userId = options.userId;
  const maxQueueInsertsPerRun = Math.max(1, Number(process.env.DISCOVER_MAX_QUEUE_INSERTS ?? 5));
  // "Recently used" must actually expire, or a small content pool (an artist
  // only has so many TikTok videos) permanently blocks itself after being
  // cycled through once — confirmed live: a bot with real, relevant
  // candidates queued 0 items because every one of them had been used at
  // some point, ever, with no window at all. Count-based (not calendar-day)
  // so it naturally scales with posting frequency, same as the existing
  // NO_REPEAT_MEDIA_WINDOW_POSTS pattern.
  const sourceReuseWindowPosts = Math.max(1, Number(process.env.SOURCE_REUSE_WINDOW_POSTS ?? 6));

  const discovery = new ContentDiscoveryService();
  const items = await discovery.discoverContent(bot, { limit: options.limit ?? 20 });

  const { data: recentSourceRows } = await supabase
    .from("content_queue")
    .select("metadata")
    .eq("bot_id", id)
    .in("status", ["queued", "ready", "posted", "publishing"])
    .order("created_at", { ascending: false })
    .limit(sourceReuseWindowPosts);

  // Compare canonical URLs, not raw ones — DuckDuckGo appends a random "rut="
  // tracking token to every result link, so the exact same TikTok/YouTube URL
  // looks "new" on every fresh search unless the redirect wrapper + tracking
  // token are stripped first. Confirmed live: the same TikTok video slipped
  // through this exact dedup check 3 times because of that random token.
  const recentSourceUrls = new Set<string>();
  const recentOriginMediaUrls = new Set<string>();
  for (const row of recentSourceRows ?? []) {
    const metadata = row.metadata as Record<string, unknown> | null;
    if (typeof metadata?.source_url === "string") recentSourceUrls.add(normalizeSourceUrl(metadata.source_url));
    if (typeof metadata?.origin_media_url === "string") recentOriginMediaUrls.add(metadata.origin_media_url);
  }

  const geminiClient = new GeminiClient(getGeminiKeysForBot(bot.api_slot));
  let queued = 0;
  let skipped = 0;
  const debug: Array<Record<string, unknown>> = [];

  for (const item of items) {
    if (queued >= maxQueueInsertsPerRun) {
      skipped += 1;
      debug.push({ title: item.title, sourceUrl: item.url, status: "skipped", reason: `run_queue_cap_reached:${maxQueueInsertsPerRun}` });
      continue;
    }

    if (!isFocusAligned(bot.content_target, {
      title: item.title,
      description: item.description,
      source: item.source,
      sourceUrl: item.url,
      tags: item.tags,
    })) {
      skipped += 1;
      debug.push({ title: item.title, sourceUrl: item.url, status: "skipped", reason: `out_of_focus:${bot.content_target}` });
      continue;
    }

    if (isKnownWrapperSource(item.url) || isKnownWrapperSource(item.mediaUrl)) {
      skipped += 1;
      debug.push({ title: item.title, sourceUrl: item.url, status: "skipped", reason: "known_wrapper_source" });
      continue;
    }

    if (recentSourceUrls.has(normalizeSourceUrl(item.url))) {
      skipped += 1;
      debug.push({ title: item.title, sourceUrl: item.url, status: "skipped", reason: "duplicate_source_recently_used" });
      continue;
    }

    let mediaAssetId: string | null = null;
    let mediaUrl: string | null = null;
    let uploadedMediaType: "image" | "video" | null = null;
    let resolvedFrom: "item" | "extracted" | "local" | null = null;

    if (item.localMediaPath) {
      mediaUrl = item.localMediaPath;
      resolvedFrom = "local";
    } else if (item.mediaUrl && (await validateMediaUrl(item.mediaUrl))) {
      mediaUrl = item.mediaUrl;
      resolvedFrom = "item";
    }

    if (!mediaUrl) {
      const extracted = await extractMediaFromUrl(item.url);
      if (extracted && (await validateMediaUrl(extracted))) {
        mediaUrl = extracted;
        resolvedFrom = "extracted";
        console.log(`[${id}] Extracted media for ${item.title}: ${extracted}`);
      }
    }

    if (isKnownWrapperMediaResult(mediaUrl)) {
      skipped += 1;
      debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: "known_wrapper_extracted_media" });
      continue;
    }

    if (!mediaUrl) {
      skipped += 1;
      debug.push({ title: item.title, sourceUrl: item.url, providedMediaUrl: item.mediaUrl ?? null, status: "skipped", reason: "no_downloadable_media" });
      console.warn(`[${id}] Skipping discovery item without downloadable media: ${item.title}`);
      continue;
    }

    // Belt-and-suspenders: extractMediaFromUrl never falls back to a
    // thumbnail for TikTok/YouTube anymore, but item.mediaUrl set directly by
    // a discovery source (the "item" resolution path, which skips
    // extractMediaFromUrl entirely) could still be a thumbnail despite
    // item.mediaType saying "video". Verify before trusting it.
    if (item.mediaType === "video" && !item.localMediaPath) {
      try {
        const headRes = await fetch(mediaUrl, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) });
        const contentType = headRes.headers.get("content-type") || "";
        const contentLength = Number(headRes.headers.get("content-length") ?? 0);
        const isRealVideo = contentType.startsWith("video/") || (contentType.startsWith("application/octet-stream") && contentLength > 100_000);
        if (!isRealVideo) {
          skipped += 1;
          debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: `video_thumbnail_fallback_skipped:${contentType || "unknown"}` });
          console.warn(`[${id}] Refusing thumbnail-as-video for ${item.title}: ${contentType || "unknown"}`);
          continue;
        }
      } catch {
        // HEAD failing isn't itself disqualifying — the real fetch below
        // will still catch a genuinely broken URL.
      }
    }

    // Different search results/queries can point at the exact same underlying
    // image (e.g. an artist's official cover art reused across pages) even
    // though the source page URL differs — dedupe on the resolved media URL
    // itself too, not just the page it was found on.
    if (mediaUrl && recentOriginMediaUrls.has(mediaUrl)) {
      skipped += 1;
      debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: "duplicate_media_recently_used" });
      continue;
    }

    const originMediaUrl = mediaUrl;

    try {
      const response = item.localMediaPath ? null : await fetch(mediaUrl, { redirect: "follow", signal: AbortSignal.timeout(45_000) });
      if (response && !response.ok) {
        skipped += 1;
        debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: `media_fetch_failed:${response.status}` });
        console.warn(`[${id}] Media fetch failed for ${item.title}: ${response.status} ${response.statusText}`);
        continue;
      }

      const contentType = item.localMediaPath ? localMediaContentType(item.localMediaPath) : response?.headers.get("content-type") || "";
      const contentLength = item.localMediaPath ? (await fs.stat(item.localMediaPath)).size : Number(response?.headers.get("content-length") ?? 0);
      // TikTok's CDN serves real video as application/octet-stream instead of
      // video/mp4 (confirmed live) — a large octet-stream is real media, a
      // tiny one is far more likely an error page.
      const isOctetStreamMedia = contentType.startsWith("application/octet-stream") && Number.isFinite(contentLength) && contentLength > 100_000;
      if (!contentType.startsWith("image/") && !contentType.startsWith("video/") && !isOctetStreamMedia) {
        skipped += 1;
        debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: `unsupported_media_type:${contentType || "unknown"}` });
        console.warn(`[${id}] Unsupported media type for ${item.title}: ${contentType || "unknown"}`);
        continue;
      }

      if (contentType === "image/gif") {
        skipped += 1;
        debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: "unsupported_animated_gif" });
        console.warn(`[${id}] Skipping animated gif for ${item.title}`);
        continue;
      }

      // Discovery classified this as a video (TikTok/YouTube) but what we
      // actually got back is a plain image — that means every real-video
      // extraction attempt failed upstream. Never silently downgrade it to
      // an image post; skip it instead of passing off a thumbnail as video.
      const resolvedAsImage = contentType.startsWith("image/");
      if (item.mediaType === "video" && resolvedAsImage) {
        skipped += 1;
        debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: "video_expected_but_got_thumbnail" });
        console.warn(`[${id}] Expected video but resolved media is an image for ${item.title}, skipping`);
        continue;
      }

      const buffer = item.localMediaPath ? await fs.readFile(item.localMediaPath) : Buffer.from(await response!.arrayBuffer());
      if (buffer.length === 0) {
        skipped += 1;
        debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: "empty_media_payload" });
        console.warn(`[${id}] Empty media payload for ${item.title}`);
        continue;
      }

      // octet-stream media has no usable extension/type in the header itself.
      // item.mediaType comes from a title/description heuristic at discovery
      // time and isn't reliable enough to gate this on (confirmed live: real
      // TikTok videos titled things like "Link on bio" got misclassified as
      // non-video, so their genuinely-video octet-stream payload got uploaded
      // with a raw "application/octet-stream; charset=UTF-8" content-type,
      // which Supabase Storage rejects outright). In practice only real video
      // CDNs (TikTok) return octet-stream here, so treat it as video always.
      const isVideoPayload = contentType.startsWith("video/") || isOctetStreamMedia;
      const ext = isVideoPayload ? "mp4" : contentType.startsWith("image/") ? (contentType.split("/")[1] ?? "jpg") : "jpg";
      uploadedMediaType = isVideoPayload ? "video" : "image";
      const storagePath = `${userId}/${id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { error: uploadError } = await admin.storage.from("bot-media").upload(storagePath, buffer, {
        contentType: isVideoPayload ? "video/mp4" : contentType || "application/octet-stream",
        upsert: false,
      });

      if (uploadError) {
        skipped += 1;
        debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: `storage_upload_failed:${uploadError.message}` });
        console.warn(`[${id}] Failed to upload media for ${item.title}: ${uploadError.message}`);
        continue;
      }

      // bot-media is a private bucket — a "public" URL 400s on fetch. Sign it
      // so the verification re-fetch below (and anything else that reads this
      // URL) actually works.
      const { data: signedUrlData, error: signedUrlError } = await admin.storage.from("bot-media").createSignedUrl(storagePath, 3600);
      if (signedUrlError || !signedUrlData?.signedUrl) {
        skipped += 1;
        debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: `storage_sign_failed:${signedUrlError?.message ?? "unknown"}` });
        console.warn(`[${id}] Failed to sign uploaded media for ${item.title}: ${signedUrlError?.message ?? "unknown error"}`);
        continue;
      }
      mediaUrl = signedUrlData.signedUrl;

      const { data: createdMedia, error: mediaError } = await supabase
        .from("media_assets")
        .insert({
          bot_id: id,
          storage_path: storagePath,
          public_url: mediaUrl,
          media_type: uploadedMediaType,
          media_context_caption: item.title,
          tags: item.tags,
          is_ready: true,
          is_used: false,
          usage_count: 0,
        })
        .select("id")
        .single();

      if (mediaError || !createdMedia?.id) {
        skipped += 1;
        debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: `media_asset_insert_failed:${mediaError?.message || "unknown error"}` });
        console.warn(`[${id}] Failed to create media asset for ${item.title}: ${mediaError?.message || "unknown error"}`);
        continue;
      }

      mediaAssetId = createdMedia.id;
    } catch (error) {
      skipped += 1;
      const message = error instanceof Error ? error.message : "Unknown media processing error";
      debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: `media_processing_error:${message}` });
      console.warn(`[${id}] Media processing failed for ${item.title}: ${message}`);
      continue;
    }

    if (!mediaAssetId || !mediaUrl) {
      skipped += 1;
      debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: "missing_media_asset_after_processing" });
      console.warn(`[${id}] Missing media asset after processing for ${item.title}`);
      continue;
    }

    let extractedImageText: string | null = null;
    let finalMediaUrl = mediaUrl;
    let finalMediaType = uploadedMediaType;
    // Vault items were already hand-picked when downloaded/catalogued (see
    // scripts/upload-meme-vault.mjs) — re-running them through Gemini vision
    // (verify + render + OCR, up to ~4 calls each) on every discovery run
    // wasted quota and was the direct cause of "Run now" taking minutes and
    // then queuing nothing once the free-tier limit hit. Trust the curated
    // label and go straight to a single caption-gen call instead.
    let captionContext: string | null = item.source === "MemeVault" ? item.description || item.title || null : null;
    let verificationResult: MemeVerificationResult | null = null;
    let renderedMeme: RenderedMemeResult | null = null;
    let renderAttemptUsed: number | null = null;

    if (bot.content_target === "memes" && item.source !== "MemeVault" && uploadedMediaType === "image" && mediaUrl) {
      try {
        const imgResponse = await fetch(mediaUrl, { signal: AbortSignal.timeout(30_000) });
        if (imgResponse.ok) {
          const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());
          const imgBase64 = imgBuffer.toString("base64");
          const contentTypeHeader = imgResponse.headers.get("content-type") || "image/jpeg";
          verificationResult = await verifyAndClassifyMemeCandidate({
            imageBase64: imgBase64,
            mimeType: contentTypeHeader.split(";")[0].trim(),
            sourceTitle: item.title,
            sourceDescription: item.description,
            mediaTags: item.tags,
            apiKeys: getGeminiKeysForBot(bot.api_slot),
          });

          const fallbackPlan = buildFallbackMemePlan({
            verificationResult,
            sourceTitle: item.title,
            sourceDescription: item.description,
            mediaTags: item.tags,
          });

          if (!verificationResult.accepted && !fallbackPlan.proceed) {
            skipped += 1;
            debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: `verification_rejected:${verificationResult.reason}` });
            console.warn(`[${id}] Rejected discovery candidate "${item.title}" (${verificationResult.reason})`);
            if (verificationResult.reason === "verification_error") {
              console.warn(`[${id}] Gemini verification is failing (quota/network) — stopping this run instead of retrying it on every remaining candidate.`);
              break;
            }
            continue;
          }

          if (verificationResult.hasReadableText && verificationResult.extractedText) {
            extractedImageText = verificationResult.extractedText.trim();
            captionContext = extractedImageText;
          } else {
            const renderText = verificationResult.suggestedJoke?.trim() || fallbackPlan.renderText;
            if (renderText) {
              let renderSucceeded = false;
              for (const attempt of [1, 2] as const) {
                renderedMeme = await renderJokeOntoImage({
                  imageUrl: mediaUrl,
                  jokeText: renderText,
                  style: "tweet_screenshot",
                  attempt,
                });

                if (!renderedMeme.ok || !renderedMeme.buffer) {
                  console.warn(`[${id}] Render attempt ${attempt} failed for "${item.title}": ${renderedMeme.reason || "unknown"}`);
                  continue;
                }

                const renderBuffer = Buffer.from(renderedMeme.buffer);
                const renderStoragePath = `${userId}/${id}/${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
                const { error: renderUploadError } = await admin.storage.from("bot-media").upload(renderStoragePath, renderBuffer, {
                  contentType: "image/png",
                  upsert: false,
                });

                if (renderUploadError) {
                  console.warn(`[${id}] Render upload failed for "${item.title}": ${renderUploadError.message}`);
                  continue;
                }

                const { data: renderUrlData } = await admin.storage.from("bot-media").createSignedUrl(renderStoragePath, 3600);
                finalMediaUrl = renderUrlData?.signedUrl ?? finalMediaUrl;
                finalMediaType = "image";

                const renderBase64 = renderBuffer.toString("base64");
                const ocrResult = await geminiClient.analyzeMemeImage({
                  imageBase64: renderBase64,
                  mimeType: "image/png",
                  sourceTitle: item.title,
                  sourceDescription: item.description,
                  mediaTags: item.tags,
                });

                if (ocrResult.hasReadableText && ocrResult.extractedText?.trim()) {
                  renderAttemptUsed = attempt;
                  renderSucceeded = true;
                  extractedImageText = ocrResult.extractedText.trim();
                  captionContext = extractedImageText;
                  break;
                }

                console.warn(`[${id}] Render OCR attempt ${attempt} was not legible for "${item.title}"`);
              }

              if (!renderSucceeded) {
                skipped += 1;
                debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: "render_ocr_unverified", renderAttempt: renderAttemptUsed ?? 2 });
                console.warn(`[${id}] Render OCR was not legible for "${item.title}" after retry`);
                continue;
              }
            }

            if (!captionContext) {
              captionContext = renderText || fallbackPlan.captionContext || null;
            }
          }
        }
      } catch (scanError) {
        console.warn(`[${id}] Meme verification/render pipeline failed for "${item.title}": ${scanError instanceof Error ? scanError.message : String(scanError)}`);
        skipped += 1;
        debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: `verification_pipeline_failed:${scanError instanceof Error ? scanError.message : "unknown"}` });
        continue;
      }
    }

    if (bot.content_target === "memes" && item.source !== "MemeVault" && uploadedMediaType === "video" && mediaUrl) {
      try {
        const keyframe = await extractVideoKeyframe(mediaUrl);
        if (!keyframe.ok || !keyframe.buffer) {
          skipped += 1;
          debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: `video_keyframe_extraction_failed:${keyframe.reason || "unknown"}` });
          console.warn(`[${id}] Video keyframe extraction failed for "${item.title}": ${keyframe.reason || "unknown"}`);
          continue;
        }

        verificationResult = await verifyAndClassifyMemeCandidate({
          imageBase64: keyframe.buffer.toString("base64"),
          mimeType: "image/jpeg",
          sourceTitle: item.title,
          sourceDescription: item.description,
          mediaTags: item.tags,
          ignoreExistingText: item.source === "Kapwing",
          apiKeys: getGeminiKeysForBot(bot.api_slot),
        });

        const fallbackPlan = buildFallbackMemePlan({
          verificationResult,
          sourceTitle: item.title,
          sourceDescription: item.description,
          mediaTags: item.tags,
        });

        if (!verificationResult.accepted && !fallbackPlan.proceed) {
          skipped += 1;
          debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: `verification_rejected:${verificationResult.reason}` });
          console.warn(`[${id}] Rejected video discovery candidate "${item.title}" (${verificationResult.reason})`);
          if (verificationResult.reason === "verification_error") {
            console.warn(`[${id}] Gemini verification is failing (quota/network) — stopping this run instead of retrying it on every remaining candidate.`);
            break;
          }
          continue;
        }

        if (verificationResult.hasReadableText && verificationResult.extractedText) {
          extractedImageText = verificationResult.extractedText.trim();
          captionContext = extractedImageText;
        } else {
          const renderText = verificationResult.suggestedJoke?.trim() || fallbackPlan.renderText;
          if (renderText) {
            let renderSucceeded = false;
            for (const attempt of [1, 2] as const) {
              const rendered = await renderJokeOntoVideo({ videoUrl: mediaUrl, jokeText: renderText, attempt });

              if (!rendered.ok || !rendered.buffer || !rendered.keyframeBuffer) {
                console.warn(`[${id}] Video render attempt ${attempt} failed for "${item.title}": ${rendered.reason || "unknown"}`);
                continue;
              }

              const renderStoragePath = `${userId}/${id}/${Date.now()}-${Math.random().toString(36).slice(2)}-meme.mp4`;
              const { error: renderUploadError } = await admin.storage.from("bot-media").upload(renderStoragePath, rendered.buffer, {
                contentType: "video/mp4",
                upsert: false,
              });

              if (renderUploadError) {
                console.warn(`[${id}] Video render upload failed for "${item.title}": ${renderUploadError.message}`);
                continue;
              }

              const { data: renderUrlData } = await admin.storage.from("bot-media").createSignedUrl(renderStoragePath, 3600);
              finalMediaUrl = renderUrlData?.signedUrl ?? finalMediaUrl;
              finalMediaType = "video";

              const ocrResult = await geminiClient.analyzeMemeImage({
                imageBase64: rendered.keyframeBuffer.toString("base64"),
                mimeType: "image/jpeg",
                sourceTitle: item.title,
                sourceDescription: item.description,
                mediaTags: item.tags,
              });

              if (ocrResult.hasReadableText && ocrResult.extractedText?.trim()) {
                renderAttemptUsed = attempt;
                renderSucceeded = true;
                extractedImageText = ocrResult.extractedText.trim();
                captionContext = extractedImageText;
                break;
              }

              console.warn(`[${id}] Video render OCR attempt ${attempt} was not legible for "${item.title}"`);
            }

            if (!renderSucceeded) {
              skipped += 1;
              debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: "video_render_ocr_unverified", renderAttempt: renderAttemptUsed ?? 2 });
              console.warn(`[${id}] Video render OCR was not legible for "${item.title}" after retry`);
              continue;
            }
          }

          if (!captionContext) {
            captionContext = verificationResult.suggestedJoke?.trim() || fallbackPlan.captionContext || null;
          }
        }
      } catch (scanError) {
        console.warn(`[${id}] Video meme verification/render pipeline failed for "${item.title}": ${scanError instanceof Error ? scanError.message : String(scanError)}`);
        skipped += 1;
        debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: `video_verification_pipeline_failed:${scanError instanceof Error ? scanError.message : "unknown"}` });
        continue;
      }
    }

    if (!captionContext) {
      captionContext = bot.content_target === "memes" ? null : item.title || item.description || null;
    }

    if (!captionContext) {
      skipped += 1;
      debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: "missing_caption_context" });
      console.warn(`[${id}] Missing caption context for "${item.title}"`);
      continue;
    }

    const generatedCaption = (await geminiClient.generateCaption({
      artist: ARTIST_CONTEXT.name,
      songs: ARTIST_CONTEXT.songs,
      persona: bot.persona,
      additionalPersona: bot.additional_persona,
      contentTarget: bot.content_target,
      location: [bot.city, bot.country].filter(Boolean).join(", "),
      mediaTags: item.tags,
      sourceContext: captionContext,
    })).trim();

    const { error: queueInsertError } = await supabase.from("content_queue").insert({
      bot_id: id,
      media_asset_id: mediaAssetId,
      status: "queued",
      surface: finalMediaType === "video" ? "reel" : "feed",
      generated_caption: generatedCaption || null,
      metadata: {
        source: item.source,
        source_url: item.url,
        discovery_title: item.title,
        discovery_description: item.description,
        media_type: finalMediaType,
        source_media_type: item.mediaType,
        relevance_score: item.relevanceScore,
        tags: item.tags,
        media_url: finalMediaUrl,
        origin_media_url: originMediaUrl,
        extracted_media: finalMediaUrl !== (item.mediaUrl ?? null),
        video_pipeline_required: finalMediaType === "video",
        extracted_image_text: extractedImageText,
        caption_context: captionContext,
        verification_reason: verificationResult?.reason ?? null,
      },
    });

    if (queueInsertError) {
      skipped += 1;
      debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "skipped", reason: `queue_insert_failed:${queueInsertError.message}` });
      console.warn(`[${id}] Failed to queue discovery item ${item.title}: ${queueInsertError.message}`);
      continue;
    }

    queued += 1;
    debug.push({ title: item.title, sourceUrl: item.url, mediaUrl, resolvedFrom, status: "queued", reason: "ok" });

  }

  return { discovered: items.length, queued, skipped, debug };
}
