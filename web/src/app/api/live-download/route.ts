import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { hasLocalSession } from "@/lib/local-auth";
import { extractMediaFromUrl } from "@/lib/discovery-media";

const ALLOWED_SOURCE_HOSTS = ["tiktok.com", "facebook.com", "youtube.com", "youtu.be", "twitter.com", "x.com"];
const MAX_BYTES = 300 * 1024 * 1024;

function isAllowedSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_SOURCE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function stripAudio(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-y", "-i", inputPath, "-map", "0:v:0", "-c:v", "copy", "-an", outputPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => { stderr += String(chunk); });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not remove source audio: ${stderr.slice(-500)}`));
    });
  });
}

export async function GET(request: Request) {
  if (!(await hasLocalSession())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sourceUrl = new URL(request.url).searchParams.get("url");
  if (!sourceUrl || !isAllowedSourceUrl(sourceUrl)) {
    return Response.json({ error: "A supported TikTok, Facebook, YouTube, or X post URL is required." }, { status: 400 });
  }

  let tempDir: string | null = null;
  try {
    const mediaUrl = await extractMediaFromUrl(sourceUrl);
    if (!mediaUrl) {
      return Response.json({ error: "Could not extract a downloadable video from this post." }, { status: 422 });
    }

    const response = await fetch(mediaUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) {
      return Response.json({ error: "Could not download this video." }, { status: 422 });
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BYTES) {
      return Response.json({ error: "This video is too large to download." }, { status: 413 });
    }

    const sourceBytes = Buffer.from(await response.arrayBuffer());
    if (sourceBytes.byteLength > MAX_BYTES) {
      return Response.json({ error: "This video is too large to download." }, { status: 413 });
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marathon-live-download-"));
    const inputPath = path.join(tempDir, "source.mp4");
    const outputPath = path.join(tempDir, "silent.mp4");
    await fs.writeFile(inputPath, sourceBytes);
    await stripAudio(inputPath, outputPath);
    const silentVideo = await fs.readFile(outputPath);

    return new Response(silentVideo, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": "attachment; filename=marathon-live-video-silent.mp4",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not download this video." }, { status: 422 });
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  }
}