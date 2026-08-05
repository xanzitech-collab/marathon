import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";

interface PrepareGenericImageInput {
  supabase: SupabaseClient;
  userId: string;
  botId: string;
  queueItemId: string;
  mediaUrl: string;
}

export interface PreparedGenericImage {
  publishMediaUrl: string;
  storagePath: string;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}. ${stderr.slice(-500)}`));
    });
  });
}

async function downloadImage(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download image (${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);
}

/**
 * Scraped web images (YouTube thumbnails, og:image previews, tiny profile
 * pics) come in every shape and size. This forces every non-meme feed image
 * into Instagram's recommended 4:5 portrait canvas (1080x1350): scale to
 * cover, then center-crop — never stretches, never leaves a small/odd-ratio
 * thumbnail as-is.
 */
export async function prepareGenericImageForPublish(input: PrepareGenericImageInput): Promise<PreparedGenericImage> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marathon-feed-image-"));
  try {
    const sourcePath = path.join(tempDir, "source");
    const outputPath = path.join(tempDir, "feed-4x5.jpg");

    await downloadImage(input.mediaUrl, sourcePath);
    await runFfmpeg([
      "-y",
      "-i",
      sourcePath,
      "-vf",
      "scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350",
      "-frames:v",
      "1",
      "-q:v",
      "3",
      outputPath,
    ]);

    const buffer = await fs.readFile(outputPath);
    const storagePath = `${input.userId}/${input.botId}/feed-renders/${input.queueItemId}-${Date.now()}.jpg`;
    const { error: uploadError } = await input.supabase.storage.from("bot-media").upload(storagePath, buffer, {
      contentType: "image/jpeg",
      upsert: false,
    });

    if (uploadError) {
      throw new Error(`Feed image upload failed: ${uploadError.message}`);
    }

    const { data: signed, error: signedError } = await input.supabase.storage
      .from("bot-media")
      .createSignedUrl(storagePath, 60 * 60);

    if (signedError || !signed?.signedUrl) {
      throw new Error(`Could not sign prepared feed image: ${signedError?.message ?? "unknown error"}`);
    }

    return { publishMediaUrl: signed.signedUrl, storagePath };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
