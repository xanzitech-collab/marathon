import type { Database } from "@/types/db";

export type Bot = Database["public"]["Tables"]["bots"]["Row"];
export type MediaAsset = Database["public"]["Tables"]["media_assets"]["Row"];
export type Song = Database["public"]["Tables"]["songs"]["Row"];
export type QueueItem = Database["public"]["Tables"]["content_queue"]["Row"];
export type PostingWindow = Database["public"]["Tables"]["bot_posting_windows"]["Row"];

export interface BotHealth {
  xenrioKeyConnected: boolean;
  geminiKeyConnected: boolean;
  instagramConnected: boolean;
  isReady: boolean;
  issues: string[];
}

export interface BotWithHealth extends Bot {
  health: BotHealth;
  externalPostCount?: number | null;
}
