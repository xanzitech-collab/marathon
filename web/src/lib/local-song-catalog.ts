import path from "node:path";
import { promises as fs } from "node:fs";

const MUSIC_DIRECTORY = path.join(process.cwd(), "public", "music");
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".mp4", ".webm"]);

export interface LocalSong {
  id: string;
  bot_id: string;
  title: string;
  artist: string | null;
  mood: string | null;
  tags: string[];
  storage_path: string;
  duration_seconds: number | null;
  weight: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function inferTitle(filename: string): string {
  const name = filename.replace(/\.[^.]+$/, "");
  return name.replace(/^only1marathon\s*-\s*/i, "").trim() || name;
}

function inferMood(title: string): string {
  const normalized = title.toLowerCase();
  if (/(love|tonight|valentino)/.test(normalized)) return "romantic";
  if (/(bad|gangsta|dnd)/.test(normalized)) return "street";
  if (/(today|some more)/.test(normalized)) return "vibes";
  return "neutral";
}

export async function listLocalSongs(botId: string): Promise<LocalSong[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(MUSIC_DIRECTORY);
  } catch {
    return [];
  }

  return entries
    .filter((filename) => AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase()))
    .sort((left, right) => left.localeCompare(right))
    .map((filename) => {
      const title = inferTitle(filename);
      const mood = inferMood(title);
      return {
        id: `local:${filename}`,
        bot_id: botId,
        title,
        artist: "Only1Marathon",
        mood,
        tags: ["local", "music", mood],
        storage_path: path.join(MUSIC_DIRECTORY, filename),
        duration_seconds: null,
        weight: 1,
        is_active: true,
        created_at: "",
        updated_at: "",
      };
    });
}

export async function findLocalSong(botId: string, songId: string): Promise<LocalSong | null> {
  const songs = await listLocalSongs(botId);
  return songs.find((song) => song.id === songId) ?? null;
}