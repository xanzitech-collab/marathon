import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import type { ConnectablePlatform, PlatformAccount } from "@/types/app";

export const CONNECTABLE_PLATFORMS: ConnectablePlatform[] = ["instagram", "tiktok", "facebook"];

export function isConnectablePlatform(value: string): value is ConnectablePlatform {
  return (CONNECTABLE_PLATFORMS as string[]).includes(value);
}

export async function listPlatformAccounts(
  supabase: SupabaseClient<Database>,
  botId: string,
): Promise<PlatformAccount[]> {
  const { data, error } = await supabase
    .from("bot_platform_accounts")
    .select("*")
    .eq("bot_id", botId);
  if (error) throw error;
  return data ?? [];
}

export function isPlatformRateLimited(account: Pick<PlatformAccount, "rate_limited_until">): boolean {
  if (!account.rate_limited_until) return false;
  return new Date(account.rate_limited_until).getTime() > Date.now();
}

// Persists the platform's own posting-frequency cooldown (e.g. TikTok's 429
// "wait 1h 18m") so the next publish attempt can skip that platform instead
// of blindly retrying and getting rate-limited again on every cycle.
// Untyped SupabaseClient (not SupabaseClient<Database>) — our hand-written
// Database type doesn't fully satisfy postgrest-js's generic table-resolution
// shape, which makes a strictly-typed client's .update() resolve to `never`
// (confirmed: this is the only .update() call in the codebase that used the
// typed client, and it broke the Next.js build's type check on Render).
export async function markPlatformRateLimited(
  supabase: SupabaseClient,
  botId: string,
  platform: ConnectablePlatform,
  rateLimitedUntil: string,
): Promise<void> {
  const { error } = await supabase
    .from("bot_platform_accounts")
    .update({ rate_limited_until: rateLimitedUntil })
    .eq("bot_id", botId)
    .eq("platform", platform);
  if (error) {
    console.warn(`[${botId}] Failed to persist rate limit for ${platform}: ${error.message}`);
  }
}
