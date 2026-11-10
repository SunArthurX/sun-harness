import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/replay.mjs';

test('missing attachments keep the turn and healthy images in order', () => {
  const events = Object.freeze([
    Object.freeze({ type: 'user', text: 'question', attachments: Object.freeze(['ok-a', 'private-missing', 'ok-b', 'gone']) }),
    Object.freeze({ type: 'approval', text: 'ignore' }),
    Object.freeze({ type: 'assistant', text: 'answer' }),
    Object.freeze({ type: 'user', text: 'next' }),
  ]);
  const seen = [];
  const reader = path => {
    seen.push(path);
    if (!path.startsWith('ok-')) throw Object.assign(new Error(path), { code: 'ENOENT' });
    return path.toUpperCase();
  };
  assert.deepEqual(replay(events, reader), [
    { role: 'user', text: 'question\n[Missing attachments: 2]', images: ['OK-A', 'OK-B'] },
    { role: 'assistant', text: 'answer', images: [] },
    { role: 'user', text: 'next', images: [] },
  ]);
  assert.deepEqual(seen, ['ok-a', 'private-missing', 'ok-b', 'gone']);
  assert.throws(() => replay(events, () => { throw Object.assign(new Error('permission error'), { code: 'EACCES' }); }), /permission error/);
});
