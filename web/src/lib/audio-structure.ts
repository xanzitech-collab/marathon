export interface AudioStructureHint {
  startSeconds: number;
  score: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function chooseStrategicAudioStart(
  durationSeconds: number | null,
  clipDurationSeconds: number,
  seed: string,
  structureHints: AudioStructureHint[] = [],
): number {
  if (!durationSeconds || durationSeconds <= clipDurationSeconds + 2) {
    return 0;
  }

  const introFloor = Math.max(6, Number(process.env.SONG_CLIP_MIN_OFFSET_SECONDS ?? 12));
  const endBuffer = Math.max(4, Number(process.env.SONG_CLIP_END_BUFFER_SECONDS ?? 10));
  const maxStart = Math.max(0, durationSeconds - clipDurationSeconds - endBuffer);
  if (maxStart <= 0) {
    return 0;
  }

  const hash = hashString(seed);
  const structureCandidates = structureHints
    .map((hint) => ({
      startSeconds: clamp(Math.round(hint.startSeconds), introFloor, maxStart),
      score: hint.score,
    }))
    .filter((candidate) => candidate.startSeconds >= introFloor && candidate.startSeconds <= maxStart)
    .sort((left, right) => right.score - left.score);

  if (structureCandidates.length > 0) {
    const jitterWindow = Math.min(4, Math.max(0, Math.floor((maxStart - introFloor) / 10)));
    const jitter = jitterWindow > 0 ? (hash % (jitterWindow * 2 + 1)) - jitterWindow : 0;
    const baseStart = structureCandidates[Math.abs(hash) % structureCandidates.length]?.startSeconds ?? structureCandidates[0].startSeconds;
    return clamp(baseStart + jitter, introFloor, maxStart);
  }

  const fractions = [0.18, 0.32, 0.48, 0.62, 0.74];
  const candidates = fractions
    .map((fraction) => Math.round(durationSeconds * fraction))
    .filter((start) => start >= introFloor && start <= maxStart);

  if (candidates.length === 0) {
    return Math.min(maxStart, Math.max(introFloor, Math.round(durationSeconds * 0.35)));
  }

  const baseStart = candidates[hash % candidates.length] ?? candidates[0] ?? 0;
  const jitterWindow = Math.min(5, Math.max(0, Math.floor((maxStart - introFloor) / 8)));
  const jitter = jitterWindow > 0 ? (hash % (jitterWindow * 2 + 1)) - jitterWindow : 0;
  return Math.max(introFloor, Math.min(maxStart, baseStart + jitter));
}
