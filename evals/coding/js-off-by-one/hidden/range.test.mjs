import { test } from 'node:test'; import assert from 'node:assert/strict';
import { range } from '../src/range.js';
test('inclusive', () => assert.deepEqual(range(1, 4), [1, 2, 3, 4]));
test('single', () => assert.deepEqual(range(5, 5), [5]));
test('empty', () => assert.deepEqual(range(3, 1), []));
test('negative', () => assert.deepEqual(range(-2, 0), [-2, -1, 0]));
