import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function inferTitle(filename) {
  const noExt = filename.replace(/\.[^.]+$/, "");
  const cleaned = noExt.replace(/^only1marathon\s*-\s*/i, "").trim();
  return cleaned || noExt;
}

function inferMood(title) {
  const t = title.toLowerCase();
  if (/(love|tonight|valentino)/.test(t)) return "romantic";
  if (/(bad|gangsta|dnd)/.test(t)) return "street";
  if (/(today|some more)/.test(t)) return "vibes";
  return "neutral";
}

function getDurationSeconds(filePath) {
  const ffprobe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { encoding: "utf8" },
  );

  if (ffprobe.status !== 0) {
    return null;
  }

  const value = Number.parseFloat((ffprobe.stdout || "").trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

async function resolveBotId(supabase, inputBotId, inputBotName) {
  if (inputBotId) {
    const { data, error } = await supabase
      .from("bots")
      .select("id")
      .eq("id", inputBotId)
      .eq("is_demo", false)
      .maybeSingle();
    if (!error && data?.id) return data.id;
    throw new Error("BOT_ID must identify a real, non-demo bot.");
  }

  if (inputBotName) {
    const { data, error } = await supabase
      .from("bots")
      .select("id,name")
      .eq("name", inputBotName)
      .eq("is_demo", false)
      .limit(1)
      .single();
    if (!error && data?.id) return data.id;
    throw new Error(`Could not find a real bot named '${inputBotName}'.`);
  }

  throw new Error("Set BOT_ID or BOT_NAME to a real, non-demo bot before uploading music.");
}

async function ensureMusicBucket(supabase, bucket) {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) {
    throw new Error(`Could not list storage buckets: ${listError.message}`);
  }

  const exists = (buckets ?? []).some((item) => item.name === bucket || item.id === bucket);
  if (exists) return;

  const { error: createError } = await supabase.storage.createBucket(bucket, {
    public: false,
  });

  if (createError) {
    throw new Error(`Could not create '${bucket}' bucket: ${createError.message}`);
  }
}

async function ensureSongsTableReady(supabase) {
  const { error } = await supabase.from("songs").select("id").limit(1);
  if (!error) return;

  const missing = /could not find the table|relation .* does not exist/i.test(error.message);
  if (missing) {
    throw new Error("Missing songs table. Apply migration supabase/migrations/20260803_0005_music_catalog.sql first.");
  }

  throw new Error(`Could not validate songs table: ${error.message}`);
}

async function main() {
  const scriptFilePath = fileURLToPath(import.meta.url);
  const rootDir = path.resolve(path.dirname(scriptFilePath), "..");
  loadEnvFile(path.join(rootDir, ".env.local"));
  loadEnvFile(path.join(rootDir, ".env"));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const musicDir = process.env.MUSIC_SOURCE_DIR
    ? path.resolve(process.env.MUSIC_SOURCE_DIR)
    : path.join(rootDir, "public", "music");
  if (!fs.existsSync(musicDir)) {
    throw new Error(`Music source directory does not exist: ${musicDir}`);
  }

  const files = fs
    .readdirSync(musicDir)
    .filter((name) => /\.(mp3|wav|m4a|aac)$/i.test(name))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    console.log("No audio files found in source directory.");
    return;
  }

  const botId = await resolveBotId(supabase, process.env.BOT_ID, process.env.BOT_NAME ?? "Only1Marathon");
  const artist = process.env.ARTIST_NAME ?? "Only1Marathon";
  const bucket = process.env.SUPABASE_MUSIC_BUCKET ?? "music";

  await ensureSongsTableReady(supabase);
  await ensureMusicBucket(supabase, bucket);

  let uploaded = 0;
  let upserted = 0;

  for (const filename of files) {
    const sourcePath = path.join(musicDir, filename);
    const bytes = fs.readFileSync(sourcePath);
    const title = inferTitle(filename);
    const mood = inferMood(title);
    const ext = path.extname(filename).toLowerCase() || ".mp3";
    const storageFile = `${slugify(title)}${ext}`;
    const storagePath = `${botId}/${storageFile}`;

    const { error: uploadError } = await supabase.storage.from(bucket).upload(storagePath, bytes, {
      upsert: true,
      contentType: ext === ".wav" ? "audio/wav" : "audio/mpeg",
    });

    if (uploadError) {
      console.error(`Upload failed for ${filename}: ${uploadError.message}`);
      continue;
    }

    uploaded += 1;

    const duration = getDurationSeconds(sourcePath);
    const tags = ["local-upload", "music", mood];

    const { error: songError } = await supabase.from("songs").upsert(
      {
        bot_id: botId,
        title,
        artist,
        mood,
        tags,
        storage_path: storagePath,
        duration_seconds: duration,
        is_active: true,
      },
      { onConflict: "bot_id,storage_path" },
    );

    if (songError) {
      console.error(`Songs upsert failed for ${filename}: ${songError.message}`);
      continue;
    }

    upserted += 1;
    console.log(`Synced: ${filename} -> ${storagePath} (${duration ?? "unknown"}s)`);
  }

  const { data: summary, error: summaryError } = await supabase
    .from("songs")
    .select("id,title,mood,storage_path,duration_seconds")
    .eq("bot_id", botId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(20);

  if (summaryError) {
    console.warn(`Upload completed but could not fetch summary: ${summaryError.message}`);
  } else {
    console.log(`\nActive songs for bot ${botId}:`);
    for (const row of summary ?? []) {
      console.log(`- ${row.title} [${row.mood}] ${row.duration_seconds ?? "?"}s :: ${row.storage_path}`);
    }
  }

  console.log(`\nCompleted. Uploaded: ${uploaded}, upserted: ${upserted}, source files: ${files.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Music upload failed");
  process.exitCode = 1;
});
