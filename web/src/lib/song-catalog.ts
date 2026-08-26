import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

export type CatalogSong = Database["public"]["Tables"]["songs"]["Row"];

export async function listSongsForBot(supabase: SupabaseClient<Database>, botId: string): Promise<CatalogSong[]> {
  const { data, error } = await supabase
    .from("songs")
    .select("*")
    .eq("bot_id", botId)
    .eq("is_active", true)
    .order("title");

  if (error) {
    console.warn(`[song-catalog] Could not load songs for ${botId}: ${error.message}`);
    return [];
  }

  return data ?? [];
}

export async function findSongForBot(
  supabase: SupabaseClient<Database>,
  botId: string,
  songId: string,
): Promise<CatalogSong | null> {
  const { data, error } = await supabase
    .from("songs")
    .select("*")
    .eq("id", songId)
    .eq("bot_id", botId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.warn(`[song-catalog] Could not load song ${songId}: ${error.message}`);
    return null;
  }

  return data;
}

function targetMood(contentTarget: string): string {
  switch (contentTarget) {
    case "memes":
    case "viral_trends":
    case "lifestyle_vibes":
      return "vibes";
    case "song_snippets":
    case "fan_reactions":
      return "street";
    case "release_promo":
    case "new_release_countdown":
      return "hype";
    default:
      return "neutral";
  }
}

function pickWeightedSong(candidates: CatalogSong[]): CatalogSong | null {
  if (candidates.length === 0) return null;

  const total = candidates.reduce((sum, song) => sum + (song.weight > 0 ? song.weight : 1), 0);
  let roll = Math.random() * total;

  for (const song of candidates) {
    const w = song.weight > 0 ? song.weight : 1;
    roll -= w;
    if (roll <= 0) return song;
  }

  return candidates[candidates.length - 1] ?? null;
}

export async function pickSongForBot(
  supabase: SupabaseClient<Database>,
  botId: string,
  contentTarget: string,
  options?: { excludeSongIds?: string[] },
): Promise<CatalogSong | null> {
  const preferredMood = targetMood(contentTarget);
  const excluded = new Set((options?.excludeSongIds ?? []).filter(Boolean));
  const songs = await listSongsForBot(supabase, botId);
  const preferredSongs = songs.filter((song) => song.mood === preferredMood);
  const preferredFiltered = preferredSongs.filter((song) => !excluded.has(song.id));
  const firstPick = pickWeightedSong(preferredFiltered);
  if (firstPick) return firstPick;
  const fallbackFiltered = songs.filter((song) => !excluded.has(song.id));
  return pickWeightedSong(fallbackFiltered.length > 0 ? fallbackFiltered : songs);
}
