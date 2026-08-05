import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ARTIST_CONTEXT } from "@/lib/artist";
import { getGeminiKeysForBot } from "@/lib/config";
import { GeminiClient } from "@/lib/gemini/client";

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
    const vaultItemId = typeof body.vaultItemId === "string" ? body.vaultItemId : null;
    if (!vaultItemId) return NextResponse.json({ error: "vaultItemId is required" }, { status: 400 });

    const admin = createAdminClient();
    const { data: item, error: itemError } = await admin
      .from("meme_vault_items")
      .select("category, source, original_filename, context_text")
      .eq("id", vaultItemId)
      .single();

    if (itemError || !item) throw new Error("Vault item not found");

    const tags = ["meme", item.category, item.source];
    const geminiClient = new GeminiClient(getGeminiKeysForBot(bot.api_slot));
    const caption = (
      await geminiClient.generateCaption({
        artist: ARTIST_CONTEXT.name,
        songs: ARTIST_CONTEXT.songs,
        persona: bot.persona,
        additionalPersona: bot.additional_persona,
        contentTarget: bot.content_target,
        location: [bot.city, bot.country].filter(Boolean).join(", "),
        mediaTags: tags,
        sourceContext: item.context_text || item.original_filename,
      })
    ).trim();

    return NextResponse.json({ caption, tags });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
