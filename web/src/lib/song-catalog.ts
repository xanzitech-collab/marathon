import { listLocalSongs, type LocalSong } from "@/lib/local-song-catalog";

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

function pickWeightedSong(candidates: LocalSong[]): LocalSong | null {
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
  botId: string,
  contentTarget: string,
  options?: { excludeSongIds?: string[] },
): Promise<LocalSong | null> {
  const preferredMood = targetMood(contentTarget);
  const excluded = new Set((options?.excludeSongIds ?? []).filter(Boolean));
  const songs = await listLocalSongs(botId);
  const preferredSongs = songs.filter((song) => song.mood === preferredMood);
  const preferredFiltered = preferredSongs.filter((song) => !excluded.has(song.id));
  const firstPick = pickWeightedSong(preferredFiltered);
  if (firstPick) return firstPick;
  const fallbackFiltered = songs.filter((song) => !excluded.has(song.id));
  return pickWeightedSong(fallbackFiltered.length > 0 ? fallbackFiltered : songs);
}
