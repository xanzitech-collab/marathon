import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { queueAndPublishManualItem } from "@/lib/manual-queue";

interface Params {
  params: Promise<{ id: string }>;
}

interface LiveItemInput {
  mediaAssetId: string;
  mediaType: "image" | "video";
  caption: string;
  tags: string[];
  songId: string | null;
  noSong: boolean;
  sourceUrl: string;
  sourceLabel: string;
  discoveryTitle?: string | null;
  discoveryDescription?: string | null;
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
    const rawItems = Array.isArray(body.items) ? (body.items as LiveItemInput[]) : [];
    if (rawItems.length === 0) {
      return NextResponse.json({ error: "No items selected" }, { status: 400 });
    }

    const admin = createAdminClient();
    const results: Array<{ mediaAssetId: string; queued: boolean; published: boolean; error?: string }> = [];

    for (const input of rawItems) {
      const result: { mediaAssetId: string; queued: boolean; published: boolean; error?: string } = {
        mediaAssetId: input.mediaAssetId,
        queued: false,
        published: false,
      };
      results.push(result);

      try {
        const manualResult = await queueAndPublishManualItem(admin, bot, {
          botId: id,
          mediaAssetId: input.mediaAssetId,
          mediaType: input.mediaType,
          caption: input.caption,
          tags: input.tags,
          songId: input.songId,
          noSong: input.noSong,
          source: input.sourceLabel || "Live",
          discoveryTitle: input.discoveryTitle,
          discoveryDescription: input.discoveryDescription,
          extraMetadata: { source_url: input.sourceUrl },
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
