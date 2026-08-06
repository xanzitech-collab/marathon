import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getApiKeysBySlot } from "@/lib/config";
import { XenrioClient } from "@/lib/xenrio/client";

interface Params {
  params: Promise<{ id: string; postId: string }>;
}

export async function GET(_: Request, { params }: Params) {
  try {
    const { id, postId } = await params;
    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("id,api_slot")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();
    if (botError || !bot) throw new Error("Bot not found");

    const { xenrio } = getApiKeysBySlot(bot.api_slot);
    const comments = await new XenrioClient(xenrio).listComments(postId);
    return NextResponse.json({ comments });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load comments";
    console.error("[posts/comments] GET failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { id, postId } = await params;
    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("id,api_slot")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();
    if (botError || !bot) throw new Error("Bot not found");

    const body = await request.json();
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const { xenrio } = getApiKeysBySlot(bot.api_slot);
    const comment = await new XenrioClient(xenrio).createComment(postId, message);
    return NextResponse.json({ comment });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to post comment";
    console.error("[posts/comments] POST failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
