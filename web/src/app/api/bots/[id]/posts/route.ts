import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getApiKeysBySlot } from "@/lib/config";
import { XenrioClient } from "@/lib/xenrio/client";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("id,api_slot,zernio_account_id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (botError || !bot) throw new Error("Bot not found");
    if (!bot.zernio_account_id) {
      return NextResponse.json({ posts: [] });
    }

    const { xenrio } = getApiKeysBySlot(bot.api_slot);
    const posts = await new XenrioClient(xenrio).listAccountPosts(bot.zernio_account_id);
    return NextResponse.json({ posts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load posts";
    console.error("[posts] GET failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("id,api_slot")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (botError || !bot) throw new Error("Bot not found");

    const url = new URL(request.url);
    const postId = url.searchParams.get("postId");
    if (!postId) {
      return NextResponse.json({ error: "postId is required" }, { status: 400 });
    }

    const { xenrio } = getApiKeysBySlot(bot.api_slot);
    await new XenrioClient(xenrio).deletePost(postId);

    // Best-effort: note the deletion against our own record of this post if
    // we can find it, so the activity feed doesn't keep showing it as live.
    await supabase
      .from("content_queue")
      .update({ error_message: "Deleted by user from the Posts tab" })
      .eq("bot_id", id)
      .eq("provider_post_id", postId);

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete post";
    console.error("[posts] DELETE failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("id,api_slot")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (botError || !bot) throw new Error("Bot not found");

    const body = await request.json();
    const postId = typeof body.postId === "string" ? body.postId : null;
    const caption = typeof body.caption === "string" ? body.caption : null;
    if (!postId || caption === null) {
      return NextResponse.json({ error: "postId and caption are required" }, { status: 400 });
    }

    const { xenrio } = getApiKeysBySlot(bot.api_slot);
    await new XenrioClient(xenrio).updatePostCaption(postId, caption);

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update post";
    console.error("[posts] PATCH failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
