import type { Database } from "@/types/db";

export type Bot = Database["public"]["Tables"]["bots"]["Row"];
export type MediaAsset = Database["public"]["Tables"]["media_assets"]["Row"];
export type Song = Database["public"]["Tables"]["songs"]["Row"];
export type QueueItem = Database["public"]["Tables"]["content_queue"]["Row"];
export type PostingWindow = Database["public"]["Tables"]["bot_posting_windows"]["Row"];
export type PlatformAccount = Database["public"]["Tables"]["bot_platform_accounts"]["Row"];
export type ConnectablePlatform = "instagram" | "tiktok" | "facebook";

export interface BotHealth {
  xenrioKeyConnected: boolean;
  geminiKeyConnected: boolean;
  instagramConnected: boolean;
  connectedPlatforms: ConnectablePlatform[];
  anyPlatformConnected: boolean;
  isReady: boolean;
  issues: string[];
}

export interface BotWithHealth extends Bot {
  health: BotHealth;
  platformAccounts?: PlatformAccount[];
  externalPostCount?: number | null;
}

