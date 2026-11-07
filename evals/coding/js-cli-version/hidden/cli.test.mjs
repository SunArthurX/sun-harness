import { test } from 'node:test'; import assert from 'node:assert/strict'; import { execFileSync } from 'node:child_process';
const run = (...a) => execFileSync('node', ['cli.js', ...a], { encoding: 'utf8' }).trim();
test('--version', () => assert.equal(run('--version'), '2.4.1'));
test('-v', () => assert.equal(run('-v'), '2.4.1'));
test('greet', () => assert.equal(run('Ada'), 'Hello, Ada!'));
test('help', () => assert.equal(run('--help'), 'usage: greet [name]'));
