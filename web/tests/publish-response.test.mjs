import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPublishApiError, createPublishApiResult } = require('../src/lib/publish-response.ts');

const notEligible = createPublishApiResult(false, {
  skipped: true,
  reason: 'Cooldown active',
});

assert.equal(notEligible.status, 200);
assert.equal(notEligible.body.success, false);
assert.equal(notEligible.body.skipped, true);
assert.equal(notEligible.body.reason, 'Cooldown active');

const missingAccount = createPublishApiError('Instagram account not synced from Zernio');
assert.equal(missingAccount.status, 200);
assert.equal(missingAccount.body.success, false);
assert.equal(missingAccount.body.error, 'Instagram account not synced from Zernio');

console.log('publish-response tests passed');
