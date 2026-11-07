import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { median } from '../stats.js';
test('median', () => { assert.equal(median([3, 1, 2]), 2); assert.equal(median([4, 1, 3, 2]), 2.5); assert.throws(() => median([]), RangeError); });
test('no mutation', () => { const a = [3, 1, 2]; median(a); assert.deepEqual(a, [3, 1, 2]); });
test('jsdoc', () => { const src = readFileSync('stats.js', 'utf8'); assert.match(src, /\/\*\*[\s\S]*?@param[\s\S]*?@returns[\s\S]*?\*\/\s*export function median/); });
test('named export only', () => { assert.doesNotMatch(readFileSync('stats.js', 'utf8'), /export default/); });
