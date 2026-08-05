import type { Bot, BotHealth } from "@/types/app";

export function computeBotHealth(bot: Bot): BotHealth {
  const xenrioKeyConnected = Boolean(process.env[`XENRIO_API_KEY_${bot.api_slot}`]);
  const geminiKeyConnected = Boolean(process.env[`GEMINI_API_KEY_${bot.api_slot}`]);
  const instagramConnected =
    bot.connection_status === "connected" && Boolean(bot.zernio_account_id ?? bot.instagram_business_id);

  const issues: string[] = [];
  if (!xenrioKeyConnected) issues.push("Missing Xenrio key slot");
  if (!geminiKeyConnected) issues.push("Missing Gemini key slot");
  if (!instagramConnected) issues.push("Instagram not connected");
  if (!bot.is_active) issues.push("Bot is sleeping");

  return {
    xenrioKeyConnected,
    geminiKeyConnected,
    instagramConnected,
    isReady: issues.length === 0,
    issues,
  };
}
