import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { cleanupVideoArtifacts, prepareVideoArtifacts } from "@/lib/ffmpeg-processor";
import { GeminiClient, type VideoContextResult } from "@/lib/gemini/client";

interface ProcessVideoInput {
  supabase: SupabaseClient<Database>;
  userId: string;
  botId: string;
  queueItemId: string;
  mediaUrl: string;
  geminiClient: GeminiClient;
  persona: string;
  additionalPersona?: string | null;
  contentTarget: string;
  location?: string;
  songs: string[];
  artistHandle: string;
}

interface ProcessVideoOutput {
  publishMediaUrl: string;
  renderedStoragePath: string;
  analysis: VideoContextResult;
}

async function downloadFile(url: string, outputPath: string) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download video (${response.status})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);
}

function normalizeHashtags(tags: string[]): string[] {
  return Array.from(
    new Set(
      tags
        .filter(Boolean)
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 1)
        .map((tag) => (tag.startsWith("#") ? tag : `#${tag.replace(/\s+/g, "")}`)),
    ),
  );
}

export async function processVideoForPublish(input: ProcessVideoInput): Promise<ProcessVideoOutput> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marathon-video-download-"));
  const rawVideoPath = path.join(tempDir, "source.mp4");

  let preparedTempDir = "";
  let keyframePaths: string[] = [];
  let audioPath = "";

  try {
    await downloadFile(input.mediaUrl, rawVideoPath);

    const configuredDuration = Number(process.env.VIDEO_MAX_DURATION_SECONDS ?? 30);
    const maxDurationSeconds = Number.isFinite(configuredDuration) ? Math.max(12, Math.min(60, configuredDuration)) : 30;
    const prepared = await prepareVideoArtifacts(rawVideoPath, maxDurationSeconds);
    preparedTempDir = prepared.tempDir;
    keyframePaths = prepared.keyframePaths;
    audioPath = prepared.audioPath;

    const frameBase64 = await Promise.all(keyframePaths.map((item) => fs.readFile(item).then((buf) => buf.toString("base64"))));
    const audioBase64 = await fs.readFile(audioPath).then((buf) => buf.toString("base64"));
    const transcript = await input.geminiClient.transcribeAudioBase64(audioBase64, "audio/mpeg");

    const analysis = await input.geminiClient.analyzeVideoContext({
      transcript,
      keyframeBase64: frameBase64,
      persona: input.persona,
      additionalPersona: input.additionalPersona,
      contentTarget: input.contentTarget,
      location: input.location,
      songs: input.songs,
      artistHandle: input.artistHandle,
    });

    const storagePath = `${input.userId}/${input.botId}/video-renders/${input.queueItemId}-${Date.now()}.mp4`;
    const preparedBuffer = await fs.readFile(prepared.preparedVideoPath);
    const { error: uploadError } = await input.supabase.storage.from("bot-media").upload(storagePath, preparedBuffer, {
      contentType: "video/mp4",
      upsert: true,
    });

    if (uploadError) {
      throw new Error(`Video upload failed: ${uploadError.message}`);
    }

    const { data: signed, error: signedError } = await input.supabase.storage
      .from("bot-media")
      .createSignedUrl(storagePath, 60 * 60);

    if (signedError || !signed?.signedUrl) {
      throw new Error(`Could not sign processed video: ${signedError?.message ?? "unknown error"}`);
    }

    return {
      publishMediaUrl: signed.signedUrl,
      renderedStoragePath: storagePath,
      analysis: {
        ...analysis,
        hashtags: normalizeHashtags(analysis.hashtags),
      },
    };
  } finally {
    await cleanupVideoArtifacts([tempDir, preparedTempDir, ...keyframePaths, audioPath].filter(Boolean));
  }
}
