import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { GeminiClient, type MemeImageAnalysisResult } from "@/lib/gemini/client";

interface PrepareMemeImageInput {
  supabase: SupabaseClient<Database>;
  userId: string;
  botId: string;
  queueItemId: string;
  mediaUrl: string;
  geminiClient: GeminiClient;
  sourceTitle?: string | null;
  sourceDescription?: string | null;
  mediaTags?: string[];
}

export interface PreparedMemeImage {
  publishMediaUrl: string;
  renderedStoragePath: string | null;
  analysis: MemeImageAnalysisResult;
  overlayApplied: boolean;
}

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    ffmpeg.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    ffmpeg.on("error", (error) => {
      reject(error);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}. ${stderr.slice(-500)}`));
    });
  });
}

async function downloadImage(url: string, outputPath: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(45_000) });
  if (!response.ok) {
    throw new Error(`Failed to download meme image (${response.status})`);
  }

  const contentType = response.headers.get("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) {
    throw new Error(`Meme preparation only supports images, got ${contentType}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);
  return contentType;
}

function wrapOverlayText(text: string, maxCharsPerLine = 24, maxLines = 3): string {
  const words = text
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxCharsPerLine) {
      current = next;
      continue;
    }

    if (current) {
      lines.push(current);
    }
    current = word;

    if (lines.length === maxLines - 1) {
      break;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  return lines.join("\n").slice(0, 120).trim();
}

function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:");
}

async function resolveFontPath(): Promise<string> {
  const candidates = [
    process.env.MEME_FONT_PATH,
    // Linux (Render/Docker) — installed via fonts-dejavu-core in the Dockerfile.
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    // Windows (local dev)
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "C:\\Windows\\Fonts\\Arialbd.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }

  throw new Error("No usable font found for meme text rendering");
}

async function uploadPreparedImage(
  supabase: SupabaseClient<Database>,
  storagePath: string,
  filePath: string,
): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const { error: uploadError } = await supabase.storage.from("bot-media").upload(storagePath, buffer, {
    upsert: true,
    contentType: "image/png",
  });

  if (uploadError) {
    throw new Error(`Prepared meme image upload failed: ${uploadError.message}`);
  }

  const { data: signed, error: signedError } = await supabase.storage.from("bot-media").createSignedUrl(storagePath, 60 * 60);
  if (signedError || !signed?.signedUrl) {
    throw new Error(`Could not sign prepared meme image: ${signedError?.message ?? "unknown error"}`);
  }

  return signed.signedUrl;
}

// Instagram feed rejects images outside a 0.8:1 (4:5) to 1.91:1 aspect ratio.
// Centered crop chain: first caps height for too-tall images, then caps width
// for too-wide ones, using a small safety margin inside the documented bounds.
const IG_ASPECT_RATIO_CROP = "crop='iw':'min(ih,iw/0.8)',crop='min(iw,ih*1.91)':'ih'";

async function ensureAspectRatioSafe(inputPath: string, outputPath: string): Promise<void> {
  await runFfmpeg(["-y", "-i", inputPath, "-vf", IG_ASPECT_RATIO_CROP, "-frames:v", "1", outputPath]);
}

async function renderOverlayImage(inputPath: string, outputPath: string, overlayText: string): Promise<void> {
  const fontPath = await resolveFontPath();
  const tempDir = path.dirname(outputPath);
  const textFile = path.join(tempDir, "overlay.txt");
  const wrappedText = wrapOverlayText(overlayText);

  if (!wrappedText) {
    throw new Error("Overlay text was empty after wrapping");
  }

  await fs.writeFile(textFile, wrappedText, "utf8");

  const filter = [
    "scale='min(1080,iw)':-2",
    "drawbox=x=0:y=0:w=iw:h=240:color=white@0.94:t=fill",
    `drawtext=fontfile='${escapeFilterPath(fontPath)}':textfile='${escapeFilterPath(textFile)}':reload=0:fontcolor=black:fontsize=54:line_spacing=12:x=(w-text_w)/2:y=(120-text_h/2)`,
    IG_ASPECT_RATIO_CROP,
  ].join(",");

  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-vf",
    filter,
    "-frames:v",
    "1",
    outputPath,
  ]);
}

export async function prepareMemeImageForPublish(input: PrepareMemeImageInput): Promise<PreparedMemeImage> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marathon-meme-"));
  const sourcePath = path.join(tempDir, "source-image");
  const arSafePath = path.join(tempDir, "ar-safe.png");
  const renderedPath = path.join(tempDir, "rendered-meme.png");

  try {
    const contentType = await downloadImage(input.mediaUrl, sourcePath);
    const sourceBase64 = await fs.readFile(sourcePath).then((buffer) => buffer.toString("base64"));

    const originalAnalysis = await input.geminiClient.analyzeMemeImage({
      imageBase64: sourceBase64,
      mimeType: contentType,
      sourceTitle: input.sourceTitle,
      sourceDescription: input.sourceDescription,
      mediaTags: input.mediaTags,
    });

    if (originalAnalysis.hasReadableText && originalAnalysis.isMeme) {
      await ensureAspectRatioSafe(sourcePath, arSafePath);
      const storagePath = `${input.userId}/${input.botId}/meme-renders/${input.queueItemId}-${Date.now()}-ar.png`;
      const signedUrl = await uploadPreparedImage(input.supabase, storagePath, arSafePath);
      return {
        publishMediaUrl: signedUrl,
        renderedStoragePath: storagePath,
        analysis: originalAnalysis,
        overlayApplied: false,
      };
    }

    const overlayText = originalAnalysis.suggestedOverlayText.trim();
    if (!overlayText) {
      throw new Error("Gemini could not produce meme overlay text for this image");
    }

    await renderOverlayImage(sourcePath, renderedPath, overlayText);

    const renderedBase64 = await fs.readFile(renderedPath).then((buffer) => buffer.toString("base64"));
    const verifiedAnalysis = await input.geminiClient.analyzeMemeImage({
      imageBase64: renderedBase64,
      mimeType: "image/png",
      sourceTitle: input.sourceTitle,
      sourceDescription: input.sourceDescription,
      mediaTags: input.mediaTags,
    });

    if (!verifiedAnalysis.hasReadableText) {
      await ensureAspectRatioSafe(sourcePath, arSafePath);
      const storagePath = `${input.userId}/${input.botId}/meme-renders/${input.queueItemId}-${Date.now()}-ar.png`;
      const signedUrl = await uploadPreparedImage(input.supabase, storagePath, arSafePath);
      return {
        publishMediaUrl: signedUrl,
        renderedStoragePath: storagePath,
        analysis: {
          ...originalAnalysis,
          suggestedOverlayText: overlayText,
        },
        overlayApplied: false,
      };
    }

    const storagePath = `${input.userId}/${input.botId}/meme-renders/${input.queueItemId}-${Date.now()}.png`;
    const signedUrl = await uploadPreparedImage(input.supabase, storagePath, renderedPath);

    return {
      publishMediaUrl: signedUrl,
      renderedStoragePath: storagePath,
      analysis: {
        ...verifiedAnalysis,
        suggestedOverlayText: overlayText,
      },
      overlayApplied: true,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}