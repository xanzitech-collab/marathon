import type { Bot, BotHealth, ConnectablePlatform, PlatformAccount } from "@/types/app";

export function computeBotHealth(bot: Bot, platformAccounts: PlatformAccount[] = []): BotHealth {
  const xenrioKeyConnected = Boolean(process.env[`XENRIO_API_KEY_${bot.api_slot}`]);
  const geminiKeyConnected = Boolean(process.env[`GEMINI_API_KEY_${bot.api_slot}`]);

  const connectedPlatforms = platformAccounts
    .filter((account) => account.connection_status === "connected")
    .map((account) => account.platform);

  // Back-compat: bots connected before multi-platform support only have the
  // legacy single-account columns, not a bot_platform_accounts row yet.
  const legacyInstagramConnected =
    bot.connection_status === "connected" && Boolean(bot.zernio_account_id ?? bot.instagram_business_id);
  const instagramConnected = connectedPlatforms.includes("instagram") || legacyInstagramConnected;
  if (legacyInstagramConnected && !connectedPlatforms.includes("instagram")) {
    connectedPlatforms.push("instagram" as ConnectablePlatform);
  }

  const anyPlatformConnected = connectedPlatforms.length > 0;

  const issues: string[] = [];
  if (!xenrioKeyConnected) issues.push("Missing Xenrio key slot");
  if (!geminiKeyConnected) issues.push("Missing Gemini key slot");
  if (!anyPlatformConnected) issues.push("No platforms connected");
  if (!bot.is_active) issues.push("Bot is sleeping");

  return {
    xenrioKeyConnected,
    geminiKeyConnected,
    instagramConnected,
    connectedPlatforms,
    anyPlatformConnected,
    isReady: issues.length === 0,
    issues,
  };
}

