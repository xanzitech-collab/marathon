import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";

const mediaSchema = z.object({
  storage_path: z.string().min(3),
  public_url: z.string().url().optional(),
  media_type: z.enum(["image", "video"]),
  media_context_caption: z.string().min(3).max(300),
  tags: z.array(z.string().min(1)).min(1),
  duration_seconds: z.number().positive().optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (botError || !bot) throw new Error("Bot not found");

    const { data, error } = await supabase
      .from("media_assets")
      .select("*")
      .eq("bot_id", id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({ media: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (botError || !bot) throw new Error("Bot not found");

    const parsed = mediaSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("media_assets")
      .insert({
        bot_id: id,
        ...parsed.data,
      })
      .select("*")
      .single();

    if (error) throw error;
    return NextResponse.json({ media: data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const mediaId = searchParams.get("mediaId");

    if (!mediaId) return NextResponse.json({ error: "mediaId is required" }, { status: 400 });

    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (botError || !bot) throw new Error("Bot not found");

    const { error } = await supabase.from("media_assets").delete().eq("id", mediaId).eq("bot_id", id);
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
