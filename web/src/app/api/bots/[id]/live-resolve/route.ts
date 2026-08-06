import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ARTIST_CONTEXT } from "@/lib/artist";
import { getGeminiKeysForBot } from "@/lib/config";
import { GeminiClient } from "@/lib/gemini/client";
import { extractMediaFromUrl } from "@/lib/discovery-media";

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

    const body = await request.json();
    const sourceUrl = typeof body.url === "string" ? body.url : null;
    const title = typeof body.title === "string" ? body.title : "";
    const description = typeof body.description === "string" ? body.description : title;
    const tags: string[] = Array.isArray(body.tags) && body.tags.length > 0 ? body.tags : ["fan_engagement", "live"];
    if (!sourceUrl) return NextResponse.json({ error: "url is required" }, { status: 400 });

    let resolvedUrl: string | null;
    try {
      resolvedUrl = await extractMediaFromUrl(sourceUrl);
    } catch (error) {
      console.error("[live-resolve] extractMediaFromUrl crashed:", error);
      resolvedUrl = null;
    }
    if (!resolvedUrl) {
      return NextResponse.json(
        { error: "Could not extract a real downloadable video from this link (source may be blocked, removed, or login-walled)." },
        { status: 422 },
      );
    }

    let response: Response;
    try {
      response = await fetch(resolvedUrl, { signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      console.error("[live-resolve] media download fetch threw:", error);
      return NextResponse.json({ error: "Could not download this video (network error). Try another item." }, { status: 422 });
    }
    if (!response.ok) {
      return NextResponse.json({ error: `Media download failed (${response.status}). Try another item.` }, { status: 422 });
    }

    // Guard against an unexpectedly huge file blowing up server memory —
    // legit clips are well under this; anything bigger is almost certainly
    // a bad/looping stream response rather than a real short-form video.
    const MAX_BYTES = 300 * 1024 * 1024;
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BYTES) {
      return NextResponse.json({ error: "This video is too large to process. Try another item." }, { status: 422 });
    }

    const rawContentType = response.headers.get("content-type") ?? "";
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: "This video is too large to process. Try another item." }, { status: 422 });
    }
    const buffer = Buffer.from(arrayBuffer);

    // The bot-media bucket only accepts a fixed allow-list of MIME types —
    // CDNs (TikTok in particular) often send a generic/bogus content-type
    // like "application/octet-stream; charset=UTF-8", which Supabase Storage
    // rejects outright. Normalize to one of the allowed types instead of
    // trusting the upstream header verbatim.
    const isImage = rawContentType.startsWith("image/");
    const mediaType: "image" | "video" = isImage ? "image" : "video";
    const uploadContentType = isImage
      ? rawContentType.includes("png")
        ? "image/png"
        : rawContentType.includes("webp")
          ? "image/webp"
          : "image/jpeg"
      : "video/mp4";
    const ext = uploadContentType.split("/")[1] === "jpeg" ? "jpg" : uploadContentType.split("/")[1];
    const admin = createAdminClient();
    const storagePath = `${user.id}/${id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: uploadError } = await admin.storage.from("bot-media").upload(storagePath, buffer, {
      contentType: uploadContentType,
      upsert: false,
    });
    if (uploadError) throw new Error(uploadError.message);

    const { data: signedBotMedia, error: signedBotMediaError } = await admin.storage
      .from("bot-media")
      .createSignedUrl(storagePath, 3600);
    if (signedBotMediaError || !signedBotMedia?.signedUrl) throw new Error(signedBotMediaError?.message ?? "Could not sign uploaded media");

    const { data: mediaAsset, error: mediaAssetError } = await admin
      .from("media_assets")
      .insert({
        bot_id: id,
        storage_path: storagePath,
        public_url: signedBotMedia.signedUrl,
        media_type: mediaType,
        media_context_caption: title || null,
        tags,
        is_ready: true,
        is_used: false,
        usage_count: 0,
      })
      .select("id")
      .single();
    if (mediaAssetError || !mediaAsset?.id) throw new Error(mediaAssetError?.message ?? "Could not create media asset");

    const geminiClient = new GeminiClient(getGeminiKeysForBot(bot.api_slot));
    let caption = "";
    try {
      caption = (
        await geminiClient.generateCaption({
          artist: ARTIST_CONTEXT.name,
          songs: ARTIST_CONTEXT.songs,
          persona: bot.persona,
          additionalPersona: bot.additional_persona,
          contentTarget: bot.content_target,
          location: [bot.city, bot.country].filter(Boolean).join(", "),
          mediaTags: tags,
          sourceContext: description || title,
        })
      ).trim();
    } catch {
      caption = "";
    }

    return NextResponse.json({
      mediaAssetId: mediaAsset.id,
      previewUrl: signedBotMedia.signedUrl,
      mediaType,
      caption,
      tags,
    });
  } catch (error) {
    console.error("[live-resolve] failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
