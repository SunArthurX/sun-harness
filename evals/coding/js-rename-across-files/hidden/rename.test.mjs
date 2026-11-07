import { test } from 'node:test'; import assert from 'node:assert/strict'; import { execSync } from 'node:child_process';
import * as idx from '../src/index.js';
test('new name exported', () => assert.equal(idx.getDisplayName({ first: 'Ada', last: 'Lovelace' }), 'Ada Lovelace'));
test('old name gone', () => { assert.equal(idx.getUserName, undefined); assert.equal(execSync("grep -rl getUserName src || true", { encoding: 'utf8' }).trim(), ''); });
test('views work', () => assert.equal(idx.view3({ first: 'A', last: 'B' }), 'view3: A B'));
