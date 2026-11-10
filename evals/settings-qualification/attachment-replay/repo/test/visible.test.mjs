import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/replay.mjs';
test('intact attachment replay', () => assert.deepEqual(replay([{ type: 'user', text: 'hello', attachments: ['a'] }], () => 'image'), [{ role: 'user', text: 'hello', images: ['image'] }]));
