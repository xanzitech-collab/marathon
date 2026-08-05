import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { extractKeyframes, burnCaptionOntoVideo } from "@/lib/ffmpeg-processor";

export interface VideoMemeRenderInput {
  videoUrl: string;
  jokeText: string;
  attempt?: number;
}

export interface RenderedVideoMemeResult {
  ok: boolean;
  buffer?: Buffer;
  keyframeBuffer?: Buffer;
  reason?: string;
}

export interface VideoKeyframeResult {
  ok: boolean;
  buffer?: Buffer;
  reason?: string;
}

async function downloadToFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`video_download_failed:${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);
}

export async function extractVideoKeyframe(videoUrl: string): Promise<VideoKeyframeResult> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marathon-meme-video-frame-"));
  try {
    const inputPath = path.join(tempDir, "source.mp4");
    await downloadToFile(videoUrl, inputPath);
    const [framePath] = await extractKeyframes(inputPath, 1);
    const buffer = await fs.readFile(framePath);
    return { ok: true, buffer };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function renderJokeOntoVideo(input: VideoMemeRenderInput): Promise<RenderedVideoMemeResult> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marathon-meme-video-render-"));
  try {
    const inputPath = path.join(tempDir, "source.mp4");
    const outputPath = path.join(tempDir, "rendered.mp4");
    await downloadToFile(input.videoUrl, inputPath);
    await burnCaptionOntoVideo(inputPath, outputPath, input.jokeText);

    const buffer = await fs.readFile(outputPath);
    const [framePath] = await extractKeyframes(outputPath, 1);
    const keyframeBuffer = await fs.readFile(framePath);
    return { ok: true, buffer, keyframeBuffer };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
