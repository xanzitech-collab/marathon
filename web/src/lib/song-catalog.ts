import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

type SongRow = Database["public"]["Tables"]["songs"]["Row"];

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

function pickWeightedSong(candidates: SongRow[]): SongRow | null {
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
): Promise<SongRow | null> {
  const preferredMood = targetMood(contentTarget);
  const excluded = new Set((options?.excludeSongIds ?? []).filter(Boolean));

  const { data: preferred, error: preferredError } = await supabase
    .from("songs")
    .select("*")
    .eq("bot_id", botId)
    .eq("is_active", true)
    .eq("mood", preferredMood)
    .limit(50);

  if (preferredError) {
    console.warn(`[${botId}] songs query failed for preferred mood '${preferredMood}': ${preferredError.message}`);
  }

  const preferredSongs = (preferred ?? []) as SongRow[];
  const preferredFiltered = preferredSongs.filter((song) => !excluded.has(song.id));
  const firstPick = pickWeightedSong(preferredFiltered);
  if (firstPick) return firstPick;

  const { data: fallback, error: fallbackError } = await supabase
    .from("songs")
    .select("*")
    .eq("bot_id", botId)
    .eq("is_active", true)
    .limit(100);

  if (fallbackError) {
    console.warn(`[${botId}] songs fallback query failed: ${fallbackError.message}`);
    return null;
  }

  const fallbackSongs = (fallback ?? []) as SongRow[];
  const fallbackFiltered = fallbackSongs.filter((song) => !excluded.has(song.id));
  return pickWeightedSong(fallbackFiltered.length > 0 ? fallbackFiltered : fallbackSongs);
}
