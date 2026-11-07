import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupBy } from '../src/groupBy.ts';

// Compare as plain data: any object shape (including null-prototype objects) satisfies the spec.
const plain = (o) => JSON.parse(JSON.stringify(o));
test('groups', () => {
  const r = groupBy([{ t: 'a', n: 1 }, { t: 'b', n: 2 }, { t: 'a', n: 3 }], (x) => x.t);
  assert.deepEqual(plain(r), { a: [{ t: 'a', n: 1 }, { t: 'a', n: 3 }], b: [{ t: 'b', n: 2 }] });
  assert.deepEqual(plain(groupBy([], (x) => x)), {});
});
