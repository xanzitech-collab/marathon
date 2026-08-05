// Shared lock so the in-process setInterval loop and the external-cron
// /api/scheduler/tick endpoint never run a cycle concurrently — discovery
// (Gemini + ffmpeg per item) routinely takes longer than either trigger
// interval, and overlapping runs cause resource contention / spurious failures.
const globalState = globalThis as typeof globalThis & {
  __marathonAutomationLoopRunning?: boolean;
  __marathonAutomationLoopLockedAt?: number;
};

// If a cycle ever genuinely hangs (network call/child process that never
// settles), the lock would otherwise never be released and automation would
// silently stop forever until a manual server restart. Every real cycle so
// far has finished well under this — treat anything older as stuck and let a
// fresh cycle force-reclaim the lock instead of skipping forever.
const STALE_LOCK_MS = 10 * 60_000;

export function tryAcquireAutomationLock(): boolean {
  const lockedAt = globalState.__marathonAutomationLoopLockedAt;
  if (globalState.__marathonAutomationLoopRunning && lockedAt && Date.now() - lockedAt < STALE_LOCK_MS) {
    return false;
  }
  if (globalState.__marathonAutomationLoopRunning) {
    console.warn("[automation-lock] Previous cycle held the lock past the stale threshold — force-reclaiming it.");
  }
  globalState.__marathonAutomationLoopRunning = true;
  globalState.__marathonAutomationLoopLockedAt = Date.now();
  return true;
}

export function releaseAutomationLock(): void {
  globalState.__marathonAutomationLoopRunning = false;
  globalState.__marathonAutomationLoopLockedAt = undefined;
}
