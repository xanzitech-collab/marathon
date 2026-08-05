import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPublishApiResult } = require('../src/lib/publish-response.ts');

const result = createPublishApiResult(true, { postId: '123' });
assert.equal(result.body.success, true);
assert.equal(result.body.postId, '123');

console.log('caption-generation tests passed');
