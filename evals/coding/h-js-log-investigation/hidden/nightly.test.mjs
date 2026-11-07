import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nightly } from '../src/nightly.js';
test('skips users without email', async () => { const sent = [];
  const r = await nightly([{ profile: { email: ' Ada@Example.com ' } }, { profile: {} }, { profile: { email: 'b@x.io' } }, {}, { profile: { email: '' } }], async (to) => sent.push(to));
  assert.deepEqual(sent, ['ada@example.com', 'b@x.io']); assert.deepEqual(r, { sent: 2, skipped: 3 }); });
