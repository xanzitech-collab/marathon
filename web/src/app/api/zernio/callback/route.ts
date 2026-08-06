import { NextResponse } from "next/server";
import { AppError, requireUser } from "@/lib/auth";
import { XenrioClient } from "@/lib/xenrio/client";
import { getApiKeysBySlot } from "@/lib/config";
import { isConnectablePlatform } from "@/lib/platform-accounts";
import type { ConnectablePlatform } from "@/types/app";

function dashboardRedirect(url: URL, params: Record<string, string>) {
  const redirectUrl = new URL("/dashboard", url.origin);
  for (const [key, value] of Object.entries(params)) {
    redirectUrl.searchParams.set(key, value);
  }
  return NextResponse.redirect(redirectUrl);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const [botIdFromState, , platformFromState] = state.split(":");
  const botId = botIdFromState || url.searchParams.get("botId") || "";
  const platform: ConnectablePlatform = isConnectablePlatform(platformFromState ?? "") ? (platformFromState as ConnectablePlatform) : "instagram";
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
    const platformAccounts = accounts.filter((account) => account.platform.toLowerCase() === platform);

    const selected =
      (callbackAccountId ? platformAccounts.find((account) => account.id === callbackAccountId) : undefined) ??
      (callbackProfileId
        ? platformAccounts.find((account) => account.profileId === callbackProfileId)
        : undefined) ??
      (bot.zernio_profile_id
        ? platformAccounts.find((account) => account.profileId === bot.zernio_profile_id)
        : undefined) ??
      platformAccounts[0];

    if (!selected) {
      return dashboardRedirect(url, { connectError: `${platform}_account_not_found` });
    }

    const { error: upsertError } = await supabase
      .from("bot_platform_accounts")
      .upsert(
        {
          bot_id: bot.id,
          platform,
          zernio_account_id: selected.id,
          username: selected.username ?? callbackUsername ?? null,
          connection_status: "connected",
        },
        { onConflict: "bot_id,platform" },
      );
    if (upsertError) throw upsertError;

    const legacyUpdate =
      platform === "instagram"
        ? {
            zernio_account_id: selected.id,
            instagram_business_id: selected.id,
            instagram_username: selected.username ?? callbackUsername ?? bot.instagram_username,
          }
        : {};

    const { error: updateError } = await supabase
      .from("bots")
      .update({
        ...legacyUpdate,
        zernio_profile_id: selected.profileId ?? callbackProfileId ?? bot.zernio_profile_id,
        connection_status: "connected",
      })
      .eq("id", bot.id)
      .eq("user_id", user.id);

    if (updateError) throw updateError;

    return dashboardRedirect(url, { connectedBot: bot.id, zernioSynced: "1", connectedPlatform: platform });
  } catch {
    return dashboardRedirect(url, { connectError: "sync_failed" });
  }
}

