import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capture, render } from '../src/panel.mjs';

test('both locales use the denied state without exposing the adapter error', async () => {
  for (const [locale, label] of [['en', 'Screen recording permission denied'], ['zh', '屏幕录制权限被拒绝']]) {
    const expected = { state: 'denied', label, actionEnabled: false };
    let invoked = 0;
    const adapter = { status: () => 'denied', capture: async () => { invoked++; } };
    assert.deepEqual(render('denied', locale), expected);
    assert.deepEqual(await capture(adapter, locale), expected);
    assert.equal(invoked, 0);
    adapter.status = () => 'available';
    adapter.capture = async () => { throw Object.assign(new Error('FIXTURE_PRIVATE_PATH'), { code: 'PERMISSION_DENIED' }); };
    assert.deepEqual(await capture(adapter, locale), expected);
    adapter.capture = async () => { throw Object.assign(new Error('other failure'), { code: 'DISK_ERROR' }); };
    await assert.rejects(capture(adapter, locale), /other failure/);
  }
  assert.deepEqual(render('unavailable', 'en'), { state: 'unavailable', label: 'Capture is unavailable', actionEnabled: false });
  assert.equal((await capture({ status: () => 'available', capture: async () => {} }, 'en')).actionEnabled, true);
});
