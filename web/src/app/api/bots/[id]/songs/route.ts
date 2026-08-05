import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

interface Params {
  params: Promise<{ id: string }>;
}

const MUSIC_BUCKET = process.env.SUPABASE_MUSIC_BUCKET ?? "music";

// Common audio formats users are likely to upload — the "music" storage
// bucket's own allowed_mime_types must also permit these (see
// supabase/migrations/20260805_0002_expand_music_mime_types.sql).
const ALLOWED_EXTENSIONS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac", "mp4", "webm"]);

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function guessContentType(ext: string): string {
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/x-m4a";
    case "aac":
      return "audio/aac";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "mp4":
      return "audio/mp4";
    case "webm":
      return "audio/webm";
    default:
      return "application/octet-stream";
  }
}

function probeDurationSeconds(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const ffprobe = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    let stdout = "";
    ffprobe.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    ffprobe.on("error", () => resolve(null));
    ffprobe.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const value = Number.parseFloat(stdout.trim());
      resolve(Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null);
    });
  });
}

export async function GET(_: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (botError || !bot) throw new Error("Bot not found");

    const { data, error } = await supabase
      .from("songs")
      .select("*")
      .eq("bot_id", id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({ songs: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: Params) {
  let tempDir: string | null = null;
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (botError || !bot) throw new Error("Bot not found");

    const formData = await request.formData();
    const file = formData.get("file");
    const label = formData.get("title");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "An audio file is required" }, { status: 400 });
    }

    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json(
        { error: `Unsupported audio format .${ext || "?"}. Use mp3, wav, m4a, aac, ogg, flac, mp4 or webm.` },
        { status: 400 },
      );
    }

    const originalName = file.name.replace(/\.[^.]+$/, "").trim();
    const title = typeof label === "string" && label.trim() ? label.trim() : originalName || "Untitled";

    const buffer = Buffer.from(await file.arrayBuffer());

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marathon-song-upload-"));
    const tempFilePath = path.join(tempDir, `source.${ext}`);
    await fs.writeFile(tempFilePath, buffer);
    const durationSeconds = await probeDurationSeconds(tempFilePath);

    const storagePath = `${id}/${slugify(title)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const admin = createAdminClient();
    const { error: uploadError } = await admin.storage.from(MUSIC_BUCKET).upload(storagePath, buffer, {
      contentType: guessContentType(ext),
      upsert: false,
    });

    if (uploadError) throw uploadError;

    const { data: song, error: songError } = await admin
      .from("songs")
      .insert({
        bot_id: id,
        title,
        tags: ["user-upload"],
        storage_path: storagePath,
        duration_seconds: durationSeconds,
        is_active: true,
      })
      .select("*")
      .single();

    if (songError) throw songError;

    return NextResponse.json({ song }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload failed" }, { status: 500 });
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const songId = searchParams.get("songId");
    if (!songId) return NextResponse.json({ error: "songId is required" }, { status: 400 });

    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (botError || !bot) throw new Error("Bot not found");

    const { error } = await supabase.from("songs").delete().eq("id", songId).eq("bot_id", id);
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
