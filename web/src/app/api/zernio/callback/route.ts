import { NextResponse } from "next/server";
import { AppError, requireUser } from "@/lib/auth";
import { XenrioClient } from "@/lib/xenrio/client";
import { getApiKeysBySlot } from "@/lib/config";

function dashboardRedirect(url: URL, params: Record<string, string>) {
  const redirectUrl = new URL("/dashboard", url.origin);
  for (const [key, value] of Object.entries(params)) {
    redirectUrl.searchParams.set(key, value);
  }
  return NextResponse.redirect(redirectUrl);
}

function isInstagramPlatform(platform?: string) {
  return (platform ?? "").toLowerCase() === "instagram";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const [botIdFromState] = state.split(":");
  const botId = botIdFromState || url.searchParams.get("botId") || "";
  const callbackAccountId = url.searchParams.get("accountId") ?? url.searchParams.get("account_id") ?? "";
  const callbackProfileId = url.searchParams.get("profileId") ?? url.searchParams.get("profile_id") ?? "";
  const callbackUsername = url.searchParams.get("username") ?? "";

  if (!botId) {
    return dashboardRedirect(url, { connectError: "missing_bot_state" });
  }

  let supabase;
  let user;
  try {
    const auth = await requireUser();
    supabase = auth.supabase;
    user = auth.user;
  } catch (error) {
    if (error instanceof AppError && error.status === 401) {
      const signinUrl = new URL("/signin", url.origin);
      signinUrl.searchParams.set("next", `${url.pathname}${url.search}`);
      return NextResponse.redirect(signinUrl);
    }
    throw error;
  }

  const { data: bot, error: botError } = await supabase
    .from("bots")
    .select("*")
    .eq("id", botId)
    .eq("user_id", user.id)
    .single();

  if (botError || !bot) {
    return dashboardRedirect(url, { connectError: "bot_not_found" });
  }

  try {
    const { xenrio } = getApiKeysBySlot(bot.api_slot);
    const zernioClient = new XenrioClient(xenrio);
    const accounts = await zernioClient.listAccounts();
    const instagramAccounts = accounts.filter((account) => isInstagramPlatform(account.platform));

    const selected =
      (callbackAccountId ? instagramAccounts.find((account) => account.id === callbackAccountId) : undefined) ??
      (callbackProfileId
        ? instagramAccounts.find((account) => account.profileId === callbackProfileId)
        : undefined) ??
      (bot.zernio_profile_id
        ? instagramAccounts.find((account) => account.profileId === bot.zernio_profile_id)
        : undefined) ??
      instagramAccounts[0];

    if (!selected) {
      await supabase.from("bots").update({ connection_status: "error" }).eq("id", bot.id);
      return dashboardRedirect(url, { connectError: "instagram_account_not_found" });
    }

    const { error: updateError } = await supabase
      .from("bots")
      .update({
        zernio_account_id: selected.id,
        instagram_business_id: selected.id,
        instagram_username: selected.username ?? callbackUsername ?? bot.instagram_username,
        zernio_profile_id: selected.profileId ?? callbackProfileId ?? bot.zernio_profile_id,
        connection_status: "connected",
      })
      .eq("id", bot.id)
      .eq("user_id", user.id);

    if (updateError) throw updateError;

    return dashboardRedirect(url, { connectedBot: bot.id, zernioSynced: "1" });
  } catch {
    await supabase.from("bots").update({ connection_status: "error" }).eq("id", bot.id);
    return dashboardRedirect(url, { connectError: "sync_failed" });
  }
}
