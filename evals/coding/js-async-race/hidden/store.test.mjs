import { test } from 'node:test'; import assert from 'node:assert/strict';
import { saveAll, count } from '../store.js';
test('all saved', async () => { await saveAll([1, 2, 3, 4, 5, 6, 7, 8]); assert.equal(count(), 8); });
