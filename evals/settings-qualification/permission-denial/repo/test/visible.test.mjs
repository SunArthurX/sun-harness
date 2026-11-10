import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/panel.mjs';
test('unavailable remains disabled', () => assert.equal(render('unavailable','zh').actionEnabled, false));
