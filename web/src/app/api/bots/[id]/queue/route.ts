import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { queueCreateSchema } from "@/lib/validators";

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
      .from("content_queue")
      .select("*")
      .eq("bot_id", id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json({ queue: data ?? [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[queue] GET failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
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

    const parsed = queueCreateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const payload = parsed.data;

    const { data: recentQueue } = await supabase
      .from("content_queue")
      .select("generated_caption")
      .eq("bot_id", id)
      .limit(20);

    if (payload.generated_caption) {
      const normalized = payload.generated_caption.trim().toLowerCase();
      const hasDuplicate = (recentQueue ?? []).some(
        (item) => (item.generated_caption ?? "").trim().toLowerCase() === normalized,
      );

      if (hasDuplicate) {
        return NextResponse.json({ error: "Duplicate caption detected in recent queue" }, { status: 400 });
      }
    }

    const { data, error } = await supabase
      .from("content_queue")
      .insert({
        bot_id: id,
        media_asset_id: payload.media_asset_id ?? null,
        surface: payload.surface,
        scheduled_for: payload.scheduled_for ?? null,
        generated_caption: payload.generated_caption ?? null,
        status: "queued",
      })
      .select("*")
      .single();

    if (error) throw error;
    return NextResponse.json({ item: data }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[queue] POST failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Params) {
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

    const url = new URL(request.url);
    const scope = url.searchParams.get("scope");

    // "queue" clears pending/unpublished items; "logs" clears failed/cancelled
    // history. Posted items are never touched — that's the real record of
    // what actually went out to Instagram.
    const statuses = scope === "logs" ? ["failed", "cancelled"] : scope === "queue" ? ["queued", "ready"] : null;

    if (!statuses) {
      return NextResponse.json({ error: "scope must be 'queue' or 'logs'" }, { status: 400 });
    }

    const { error, count } = await supabase
      .from("content_queue")
      .delete({ count: "exact" })
      .eq("bot_id", id)
      .in("status", statuses);

    if (error) throw error;
    return NextResponse.json({ removed: count ?? 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[queue] DELETE failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
