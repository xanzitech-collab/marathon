import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { queueAndPublishManualItem } from "@/lib/manual-queue";
import { markVaultItemPosted } from "@/lib/meme-vault";
import { isConnectablePlatform } from "@/lib/platform-accounts";
import type { ConnectablePlatform } from "@/types/app";

const VAULT_BUCKET = process.env.SUPABASE_MEME_VAULT_BUCKET ?? "meme-vault";

function isConnectablePlatformArray(value: unknown): value is ConnectablePlatform[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && isConnectablePlatform(v));
}

interface Params {
  params: Promise<{ id: string }>;
}

interface ManualItemInput {
  vaultItemId: string;
  caption: string;
  tags: string[];
  songId: string | null;
  noSong: boolean;
  platforms?: string[];
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
    const rawItems = Array.isArray(body.items) ? (body.items as ManualItemInput[]) : [];
    if (rawItems.length === 0) {
      return NextResponse.json({ error: "No items selected" }, { status: 400 });
    }

    const admin = createAdminClient();
    const results: Array<{ vaultItemId: string; queued: boolean; published: boolean; error?: string }> = [];

    for (const input of rawItems) {
      const result: { vaultItemId: string; queued: boolean; published: boolean; error?: string } = {
        vaultItemId: input.vaultItemId,
        queued: false,
        published: false,
      };
      results.push(result);

      try {
        const { data: vaultItem, error: vaultError } = await admin
          .from("meme_vault_items")
          .select("*")
          .eq("id", input.vaultItemId)
          .single();
        if (vaultError || !vaultItem) throw new Error("Vault item not found");

        const { data: signed, error: signError } = await admin.storage
          .from(VAULT_BUCKET)
          .createSignedUrl(vaultItem.storage_path, 3600);
        if (signError || !signed?.signedUrl) throw new Error(signError?.message ?? "Could not sign vault media");

        const response = await fetch(signed.signedUrl, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`Vault media download failed (${response.status})`);
        const buffer = Buffer.from(await response.arrayBuffer());

        const ext = vaultItem.media_type === "video" ? "mp4" : (vaultItem.storage_path.split(".").pop() ?? "jpg");
        const storagePath = `${user.id}/${id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { error: uploadError } = await admin.storage.from("bot-media").upload(storagePath, buffer, {
          contentType: vaultItem.media_type === "video" ? "video/mp4" : "image/jpeg",
          upsert: false,
        });
        if (uploadError) throw new Error(uploadError.message);

        const { data: signedBotMedia, error: signedBotMediaError } = await admin.storage
          .from("bot-media")
          .createSignedUrl(storagePath, 3600);
        if (signedBotMediaError || !signedBotMedia?.signedUrl) throw new Error(signedBotMediaError?.message ?? "Could not sign uploaded media");

        const tags = input.tags.length > 0 ? input.tags : ["meme", vaultItem.category, vaultItem.source];

        const { data: mediaAsset, error: mediaAssetError } = await admin
          .from("media_assets")
          .insert({
            bot_id: id,
            storage_path: storagePath,
            public_url: signedBotMedia.signedUrl,
            media_type: vaultItem.media_type,
            media_context_caption: vaultItem.original_filename,
            tags,
            is_ready: true,
            is_used: false,
            usage_count: 0,
          })
          .select("id")
          .single();
        if (mediaAssetError || !mediaAsset?.id) throw new Error(mediaAssetError?.message ?? "Could not create media asset");

        result.queued = true;
        await markVaultItemPosted(admin, vaultItem.id);

        const manualResult = await queueAndPublishManualItem(admin, bot, {
          botId: id,
          mediaAssetId: mediaAsset.id,
          mediaType: vaultItem.media_type,
          caption: input.caption,
          tags,
          songId: input.songId,
          noSong: input.noSong,
          source: "MemeVault",
          discoveryTitle: vaultItem.original_filename,
          discoveryDescription: vaultItem.context_text,
          extraMetadata: { vault_item_id: vaultItem.id },
          targetPlatforms: isConnectablePlatformArray(input.platforms) ? input.platforms : undefined,
        });
        result.queued = manualResult.queued;
        result.published = manualResult.published;
        result.error = manualResult.error;
      } catch (itemError) {
        result.error = itemError instanceof Error ? itemError.message : "Unknown error";
      }
    }

    const publishedCount = results.filter((r) => r.published).length;
    return NextResponse.json({ results, publishedCount, totalCount: results.length });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
