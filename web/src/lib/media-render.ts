import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { chooseStrategicAudioStart, type AudioStructureHint } from "@/lib/audio-structure";

interface RenderInput {
  supabase: SupabaseClient<Database>;
  userId: string;
  botId: string;
  queueItemId: string;
  sourceMediaUrl: string;
  sourceMediaType: "image" | "video";
  songSignedUrl: string;
  songDurationSeconds?: number | null;
  maxDurationSeconds?: number;
}

interface RenderOutput {
  storagePath: string;
  signedUrl: string;
  audioStartSeconds: number;
  audioDurationSeconds: number | null;
}

async function downloadToFile(url: string, filePath: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, buffer);
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

function runCommand(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`${command} exited with code ${code}. ${stderr.slice(-500)}`));
    });
  });
}

async function probeAudioDurationSeconds(filePath: string): Promise<number | null> {
  try {
    const output = await runCommand("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const parsed = Number(output);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  }
  return sorted[midpoint];
}

async function detectAudioStructureHints(audioPath: string, durationSeconds: number | null): Promise<AudioStructureHint[]> {
  if (!durationSeconds || durationSeconds <= 0) {
    return [];
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marathon-structure-"));
  const pcmPath = path.join(tempDir, "analysis.pcm");

  try {
    await runFfmpeg([
      "-y",
      "-i",
      audioPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "8000",
      "-f",
      "s16le",
      pcmPath,
    ]);

    const pcmBuffer = await fs.readFile(pcmPath);
    if (pcmBuffer.length < 2 * 8000) {
      return [];
    }

    const sampleCount = Math.floor(pcmBuffer.length / 2);
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, sampleCount);
    const windowSeconds = Math.max(0.75, Math.min(2.25, durationSeconds / 40));
    const windowSize = Math.max(4000, Math.round(8000 * windowSeconds));
    const energies: number[] = [];

    for (let index = 0; index + windowSize <= samples.length; index += windowSize) {
      let sumSquares = 0;
      for (let offset = 0; offset < windowSize; offset += 1) {
        const sample = samples[index + offset] ?? 0;
        sumSquares += sample * sample;
      }
      energies.push(Math.sqrt(sumSquares / windowSize) / 32768);
    }

    if (energies.length < 4) {
      return [];
    }

    const smoothed = energies.map((energy, index) => {
      const window = energies.slice(Math.max(0, index - 1), Math.min(energies.length, index + 2));
      return window.reduce((sum, value) => sum + value, 0) / window.length;
    });

    const energyMedian = median(smoothed);
    const energySpread = Math.max(0.02, Math.max(...smoothed) - Math.min(...smoothed));
    const peakThreshold = Math.max(0.08, energyMedian + energySpread * 0.35);

    const peakCandidates: AudioStructureHint[] = [];
    for (let index = 1; index < smoothed.length - 1; index += 1) {
      const current = smoothed[index];
      const previous = smoothed[index - 1];
      const next = smoothed[index + 1];
      if (current > previous && current >= next && current >= peakThreshold) {
        const startSeconds = (index * windowSize) / 8000;
        const score = current + (current - peakThreshold) * 0.6;
        peakCandidates.push({ startSeconds, score });
      }
    }

    if (peakCandidates.length === 0) {
      const strongest = smoothed.reduce<{ index: number; value: number } | null>((best, value, index) => {
        if (!best || value > best.value) {
          return { index, value };
        }
        return best;
      }, null);

      if (strongest) {
        peakCandidates.push({
          startSeconds: (strongest.index * windowSize) / 8000,
          score: strongest.value,
        });
      }
    }

    return peakCandidates
      .filter((candidate) => candidate.startSeconds >= durationSeconds * 0.18 && candidate.startSeconds <= durationSeconds * 0.82)
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);
  } catch {
    return [];
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function renderMediaWithSoundtrack(input: RenderInput): Promise<RenderOutput> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marathon-render-"));
  const mediaInputPath = path.join(tempDir, input.sourceMediaType === "image" ? "source.jpg" : "source.mp4");
  const audioInputPath = path.join(tempDir, "song.mp3");
  const outputPath = path.join(tempDir, "rendered.mp4");

  try {
    await Promise.all([
      downloadToFile(input.sourceMediaUrl, mediaInputPath),
      downloadToFile(input.songSignedUrl, audioInputPath),
    ]);

    const maxDuration = Math.max(8, Math.min(60, input.maxDurationSeconds ?? 20));
    const audioDurationSeconds = input.songDurationSeconds ?? (await probeAudioDurationSeconds(audioInputPath));
    const structureHints = await detectAudioStructureHints(audioInputPath, audioDurationSeconds);
    const audioStartSeconds = chooseStrategicAudioStart(
      audioDurationSeconds,
      maxDuration,
      `${input.queueItemId}:${input.botId}`,
      structureHints,
    );
    const videoFilter = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2";

    // Instagram's audio-recognition needs a decent continuous stretch of the
    // song to fingerprint-match it — a source clip shorter than this leaves
    // too little audio to reliably identify, even though the exact same song
    // has matched fine on longer posts. Loop short source video to guarantee
    // a minimum runway instead of just posting whatever the clip's own length happens to be.
    const MIN_SOUNDTRACK_DURATION_SECONDS = 15;
    const sourceVideoDurationSeconds =
      input.sourceMediaType === "video" ? await probeAudioDurationSeconds(mediaInputPath) : null;
    const shouldLoopVideo =
      input.sourceMediaType === "video" &&
      sourceVideoDurationSeconds !== null &&
      sourceVideoDurationSeconds < MIN_SOUNDTRACK_DURATION_SECONDS;
    const targetDuration =
      input.sourceMediaType === "video"
        ? Math.min(maxDuration, Math.max(MIN_SOUNDTRACK_DURATION_SECONDS, sourceVideoDurationSeconds ?? maxDuration))
        : maxDuration;

    const ffmpegArgs =
      input.sourceMediaType === "image"
        ? [
            "-y",
            "-loop",
            "1",
            "-i",
            mediaInputPath,
            "-ss",
            String(audioStartSeconds),
            "-i",
            audioInputPath,
            "-t",
            String(maxDuration),
            "-vf",
            videoFilter,
            "-r",
            "30",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
            "-shortest",
            outputPath,
          ]
        : [
            "-y",
            ...(shouldLoopVideo ? ["-stream_loop", "-1"] : []),
            "-i",
            mediaInputPath,
          "-ss",
          String(audioStartSeconds),
            "-i",
            audioInputPath,
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-vf",
            videoFilter,
            "-t",
            String(targetDuration),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
            "-shortest",
            outputPath,
          ];

    await runFfmpeg(ffmpegArgs);

    const renderedBuffer = await fs.readFile(outputPath);
    const storagePath = `${input.userId}/${input.botId}/renders/${input.queueItemId}-${Date.now()}.mp4`;

    const { error: uploadError } = await input.supabase.storage.from("bot-media").upload(storagePath, renderedBuffer, {
      upsert: true,
      contentType: "video/mp4",
    });

    if (uploadError) {
      throw new Error(`Rendered upload failed: ${uploadError.message}`);
    }

    const { data: signed, error: signedError } = await input.supabase.storage.from("bot-media").createSignedUrl(storagePath, 60 * 60);
    if (signedError || !signed?.signedUrl) {
      throw new Error(`Could not sign rendered media URL: ${signedError?.message ?? "unknown error"}`);
    }

    return {
      storagePath,
      signedUrl: signed.signedUrl,
      audioStartSeconds,
      audioDurationSeconds,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
