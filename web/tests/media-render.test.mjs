import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chooseStrategicAudioStart } = require('../src/lib/audio-structure.ts');

const cases = [
  {
    name: 'prefers an earlier hook region when a chorus is detected',
    durationSeconds: 180,
    clipDurationSeconds: 20,
    seed: 'seed',
    structureHints: [{ startSeconds: 30, score: 1.2 }, { startSeconds: 42, score: 1.8 }],
    expectedMin: 20,
    expectedMax: 50,
  },
  {
    name: 'falls back to a mid-song area when no structure cues are available',
    durationSeconds: 180,
    clipDurationSeconds: 20,
    seed: 'seed',
    structureHints: [],
    expectedMin: 30,
    expectedMax: 140,
  },
];

for (const testCase of cases) {
  const start = chooseStrategicAudioStart(
    testCase.durationSeconds,
    testCase.clipDurationSeconds,
    testCase.seed,
    testCase.structureHints
  );

  assert.ok(start >= testCase.expectedMin, `${testCase.name}: expected >= ${testCase.expectedMin}, got ${start}`);
  assert.ok(start <= testCase.expectedMax, `${testCase.name}: expected <= ${testCase.expectedMax}, got ${start}`);
}

console.log('media-render tests passed');
