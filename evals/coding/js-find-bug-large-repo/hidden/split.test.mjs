import { test } from 'node:test'; import assert from 'node:assert/strict';
import { installments } from '../src/checkout/total.js';
const sum = (a) => a.reduce((x, y) => x + y, 0);
test('sums exactly', () => { for (const [t, n] of [[10000, 3], [10001, 3], [999, 7], [5, 3], [100, 1]]) assert.equal(sum(installments(t, n)), t); });
test('balanced', () => { assert.deepEqual(installments(10000, 3), [3334, 3333, 3333]); assert.deepEqual(installments(5, 3), [2, 2, 1]); });
