import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";

export interface PreparedVideoArtifacts {
  tempDir: string;
  preparedVideoPath: string;
  keyframePaths: string[];
  audioPath: string;
  durationSeconds: number;
}

function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => reject(error));

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} exited with code ${code}. ${stderr.slice(-500)}`));
    });
  });
}

async function probeDurationSeconds(videoPath: string): Promise<number> {
  try {
    const { stdout } = await runProcess("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);

    const parsed = Number.parseFloat(stdout.trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

async function probeVideoWidth(videoPath: string): Promise<number> {
  try {
    const { stdout } = await runProcess("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);

    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

// ffmpeg filter args use ":" and "," as option delimiters, so literal path
// separators/drive-letter colons must be escaped and quoted or the filter fails to parse.
function escapeFfmpegFilterPath(filePath: string): string {
  return `'${filePath.replace(/\\/g, "/").replace(/:/g, "\\:")}'`;
}

function wrapCaptionLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
    if (lines.length >= maxLines) break;
  }

  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

const CAPTION_FONT_CANDIDATES = [
  "C:/Windows/Fonts/arialbd.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
];

async function resolveCaptionFontFile(): Promise<string | null> {
  for (const candidate of CAPTION_FONT_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Burns a wrapped caption onto a white bar added above the source video
 * (mirrors the "tweet_screenshot" style used for static meme images).
 */
export async function burnCaptionOntoVideo(inputPath: string, outputPath: string, captionText: string): Promise<void> {
  const probedWidth = await probeVideoWidth(inputPath);
  const width = probedWidth > 0 ? probedWidth : 720;
  const fontSize = Math.max(26, Math.round(width / 18));
  const maxCharsPerLine = Math.max(18, Math.round(width / (fontSize * 0.55)));
  const lines = wrapCaptionLines(captionText, maxCharsPerLine, 5);
  const barHeight = fontSize * lines.length + 60;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marathon-caption-"));
  const captionFilePath = path.join(tempDir, "caption.txt");

  try {
    await fs.writeFile(captionFilePath, lines.join("\n"), "utf-8");

    const fontFile = await resolveCaptionFontFile();
    const fontPart = fontFile ? `fontfile=${escapeFfmpegFilterPath(fontFile)}` : "font=Sans";

    const filter = [
      `pad=iw:ih+${barHeight}:0:${barHeight}:color=white`,
      `drawtext=textfile=${escapeFfmpegFilterPath(captionFilePath)}:${fontPart}:fontcolor=black:fontsize=${fontSize}:x=24:y=24:line_spacing=10`,
    ].join(",");

    await runProcess("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-vf",
      filter,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      outputPath,
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function trimVideoDuration(inputPath: string, outputPath: string, maxDurationSeconds = 30): Promise<void> {
  await runProcess("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-t",
    String(maxDurationSeconds),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    outputPath,
  ]);
}

export async function extractKeyframes(videoPath: string, frameCount = 3): Promise<string[]> {
  const duration = await probeDurationSeconds(videoPath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marathon-keyframes-"));
  const output: string[] = [];

  for (let i = 0; i < frameCount; i += 1) {
    const ratio = frameCount === 1 ? 0.5 : (i + 1) / (frameCount + 1);
    const timestamp = Math.max(0, Math.floor(duration * ratio));
    const framePath = path.join(tempDir, `frame-${i + 1}.jpg`);

    await runProcess("ffmpeg", [
      "-y",
      "-ss",
      String(timestamp),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      framePath,
    ]);

    output.push(framePath);
  }

  return output;
}

export async function extractAudioTrack(videoPath: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marathon-audio-"));
  const audioPath = path.join(tempDir, "audio.mp3");

  await runProcess("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-acodec",
    "libmp3lame",
    "-ab",
    "128k",
    audioPath,
  ]);

  return audioPath;
}

export async function prepareVideoArtifacts(inputVideoPath: string, maxDurationSeconds = 30): Promise<PreparedVideoArtifacts> {
  const durationSeconds = await probeDurationSeconds(inputVideoPath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marathon-video-pipeline-"));
  const preparedVideoPath = path.join(tempDir, "prepared.mp4");

  if (durationSeconds > 60) {
    await trimVideoDuration(inputVideoPath, preparedVideoPath, maxDurationSeconds);
  } else {
    await fs.copyFile(inputVideoPath, preparedVideoPath);
  }

  const keyframePaths = await extractKeyframes(preparedVideoPath, 3);
  const audioPath = await extractAudioTrack(preparedVideoPath);

  return {
    tempDir,
    preparedVideoPath,
    keyframePaths,
    audioPath,
    durationSeconds,
  };
}

export async function cleanupVideoArtifacts(paths: string[]): Promise<void> {
  for (const filePath of paths) {
    try {
      await fs.rm(filePath, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
