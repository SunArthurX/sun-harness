import { test } from 'node:test'; import assert from 'node:assert/strict'; import { execSync } from 'node:child_process';
import { environments as e } from '../config.js';
test('only prod changed', () => { assert.equal(e.production.retries, 5); assert.equal(e.staging.retries, 3); assert.equal(e.development.retries, 3); });
test('minimal diff', () => { const d = execSync(`git diff --numstat ${process.env.EVAL_BASE} -- config.js`, { encoding: 'utf8' }).trim(); assert.match(d, /^1\t1\t/); });
