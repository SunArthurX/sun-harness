import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createLimiter } from '../src/limiter.js';
test('sliding window', () => { let t = 0; const l = createLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(l.allow('a'), true); t = 500; assert.equal(l.allow('a'), true); assert.equal(l.allow('a'), false);
  t = 1001; assert.equal(l.allow('a'), true); t = 1400; assert.equal(l.allow('a'), false); t = 1501; assert.equal(l.allow('a'), true); });
test('keys independent', () => { const l = createLimiter({ limit: 1, windowMs: 1000, now: () => 0 }); assert.equal(l.allow('a'), true); assert.equal(l.allow('b'), true); assert.equal(l.allow('a'), false); });
test('validation', () => { assert.throws(() => createLimiter({ limit: 0, windowMs: 1 }), TypeError); assert.throws(() => createLimiter({ limit: 1.5, windowMs: 1 }), TypeError); assert.throws(() => createLimiter({ limit: 1, windowMs: 0 }), TypeError); });
