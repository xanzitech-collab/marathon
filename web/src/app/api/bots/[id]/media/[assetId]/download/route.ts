import path from "node:path";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

interface Params {
  params: Promise<{ id: string; assetId: string }>;
}

export async function GET(_: Request, { params }: Params) {
  try {
    const { id, assetId } = await params;
    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();
    if (botError || !bot) throw new Error("Bot not found");

    const { data: asset, error: assetError } = await supabase
      .from("media_assets")
      .select("storage_path,media_type")
      .eq("id", assetId)
      .eq("bot_id", id)
      .single();
    if (assetError || !asset) throw new Error("Media not found");

    const { data: file, error: downloadError } = await createAdminClient().storage.from("bot-media").download(asset.storage_path);
    if (downloadError || !file) throw new Error(downloadError?.message ?? "Could not download media");

    const extension = path.extname(asset.storage_path) || (asset.media_type === "video" ? ".mp4" : ".jpg");
    return new NextResponse(file.stream(), {
      headers: {
        "Content-Type": asset.media_type === "video" ? "video/mp4" : "image/jpeg",
        "Content-Disposition": `attachment; filename="marathon-${assetId}${extension}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not download media" }, { status: 500 });
  }
}