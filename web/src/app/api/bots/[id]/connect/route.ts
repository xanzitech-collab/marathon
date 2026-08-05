import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { computeBotHealth } from "@/lib/bot-health";
import { getApiKeysBySlot } from "@/lib/config";
import { XenrioClient } from "@/lib/xenrio/client";

const connectSchema = z.object({
  mode: z.enum(["start", "sync", "manual"]).default("start"),
  instagram_business_id: z.string().min(4).optional(),
  instagram_username: z.string().min(2).optional(),
  instagram_page_id: z.string().min(4).optional(),
  zernio_account_id: z.string().min(12).optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

function isInstagramPlatform(platform?: string) {
  return (platform ?? "").toLowerCase() === "instagram";
}

async function startConnectFlow(id: string) {
  const { supabase, user } = await requireUser();

  const { data: bot, error: botError } = await supabase
    .from("bots")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (botError || !bot) {
    return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  }

  const { xenrio } = getApiKeysBySlot(bot.api_slot);
  const zernioClient = new XenrioClient(xenrio);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  let profileId = bot.zernio_profile_id;

  // Self-heal: a past bug could persist a stringified profile object instead
  // of a plain id (confirmed on a real bot row) — never send that to Zernio.
  if (profileId && profileId.trim().startsWith("{")) {
    console.warn(`[${bot.id}] Corrupted zernio_profile_id detected, recreating: ${profileId}`);
    profileId = null;
  }

  if (!profileId) {
    const created = await zernioClient.createProfile(`${bot.name} Profile`, `Only1Marathon bot ${bot.name}`);
    profileId = created.profileId;
  }

  const callbackUrl = `${appUrl}/api/zernio/callback?botId=${encodeURIComponent(bot.id)}`;
  const state = `${bot.id}:${user.id}`;

  const { authUrl } = await zernioClient.getConnectUrl("instagram", profileId, {
    redirectUri: callbackUrl,
    state,
  });

  const { data: updated, error: updateError } = await supabase
    .from("bots")
    .update({ zernio_profile_id: profileId, connection_status: "disconnected" })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("*")
    .single();

  if (updateError) throw updateError;

  return {
    authUrl,
    bot: { ...updated, health: computeBotHealth(updated) },
  };
}

export async function GET(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "start";

    if (mode !== "start") {
      return NextResponse.json({ error: "GET supports only mode=start" }, { status: 400 });
    }

    const started = await startConnectFlow(id);
    if (started instanceof NextResponse) {
      return started;
    }

    return NextResponse.redirect(started.authUrl);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to connect" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();

    // Unlink the Instagram account but keep zernio_profile_id — the Zernio
    // profile is just a container tied to this channel, not the specific IG
    // account, so reconnecting shouldn't need to recreate it.
    const { data, error } = await supabase
      .from("bots")
      .update({
        zernio_account_id: null,
        instagram_business_id: null,
        instagram_page_id: null,
        instagram_username: null,
        connection_status: "disconnected",
      })
      .eq("id", id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? "Bot not found" }, { status: 404 });
    }

    return NextResponse.json({ bot: { ...data, health: computeBotHealth(data) } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to disconnect" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();

    const body = await request.json();
    const parsed = connectSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (botError || !bot) {
      return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    }

    const payload = parsed.data;

    if (payload.mode === "start") {
      const started = await startConnectFlow(id);
      if (started instanceof NextResponse) {
        return started;
      }

      return NextResponse.json({
        authUrl: started.authUrl,
        bot: started.bot,
        message: "Redirecting to Zernio OAuth. Callback will auto-sync account to bot.",
      });
    }

    if (payload.mode === "sync") {
      const { xenrio } = getApiKeysBySlot(bot.api_slot);
      const zernioClient = new XenrioClient(xenrio);
      const accounts = await zernioClient.listAccounts();
      const instagramAccounts = accounts.filter((account) => isInstagramPlatform(account.platform));

      const selected = payload.zernio_account_id
        ? instagramAccounts.find((a) => a.id === payload.zernio_account_id)
        : (bot.zernio_profile_id
          ? instagramAccounts.find((a) => a.profileId === bot.zernio_profile_id)
          : undefined) ?? instagramAccounts[0];

      if (!selected) {
        return NextResponse.json(
          { error: "No Instagram account found in Zernio for this bot/profile. Complete OAuth first." },
          { status: 400 },
        );
      }

      const { data: updated, error: updateError } = await supabase
        .from("bots")
        .update({
          zernio_account_id: selected.id,
          instagram_business_id: selected.id,
          instagram_username: payload.instagram_username ?? selected.username ?? bot.instagram_username,
          connection_status: "connected",
        })
        .eq("id", id)
        .eq("user_id", user.id)
        .select("*")
        .single();

      if (updateError) throw updateError;

      return NextResponse.json({
        bot: { ...updated, health: computeBotHealth(updated) },
        connectedAccount: selected,
      });
    }

    if (!payload.instagram_business_id || !payload.instagram_username) {
      return NextResponse.json(
        { error: "manual mode requires instagram_business_id and instagram_username" },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from("bots")
      .update({
        instagram_business_id: payload.instagram_business_id,
        instagram_username: payload.instagram_username,
        instagram_page_id: payload.instagram_page_id,
        zernio_account_id: payload.instagram_business_id,
        connection_status: "connected",
      })
      .eq("id", id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error) throw error;

    return NextResponse.json({ bot: { ...data, health: computeBotHealth(data) } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to connect" }, { status: 500 });
  }
}
