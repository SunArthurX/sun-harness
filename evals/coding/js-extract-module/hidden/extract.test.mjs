import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { nextBusinessDay } from '../app.js';
import * as dates from '../dates.js';
test('behavior', () => { assert.equal(nextBusinessDay(new Date('2026-11-06T12:00:00Z')), '2026-11-09'); assert.equal(nextBusinessDay(new Date('2026-11-09T12:00:00Z')), '2026-11-10'); });
test('moved', () => { for (const f of ['formatDate', 'addDays', 'isWeekend']) assert.equal(typeof dates[f], 'function');
  const app = readFileSync('app.js', 'utf8'); assert.doesNotMatch(app, /function (formatDate|addDays|isWeekend)/); assert.match(app, /from '\.\/dates\.js'/); });
