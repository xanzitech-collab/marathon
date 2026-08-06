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
