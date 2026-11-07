import { test } from 'node:test'; import assert from 'node:assert/strict'; import { execSync } from 'node:child_process';
import { finalScore, helper1, helper299 } from '../lib.js';
test('score', () => { assert.equal(finalScore([1, 2, -5, 4]), 2.3); assert.equal(finalScore([-1]), 0); assert.equal(finalScore([]), 0); });
test('others untouched', () => { assert.equal(helper1(1), 2); assert.equal(helper299(1), 300); const d = execSync(`git diff --numstat ${process.env.EVAL_BASE} -- lib.js`, { encoding: 'utf8' }).trim().split('\t'); assert.ok(Number(d[0]) <= 8 && Number(d[1]) <= 4, d.join(' ')); });
