import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../src/host.mjs';
import { endpoints } from '../src/bridges.mjs';
import { form } from '../src/renderer.mjs';
import { edit } from '../src/cli.mjs';

test('defaults, UI labels, boundary validation and shared revision', () => {
  const host = createHost({ future: ['keep'] });
  const { ipc, gateway } = endpoints(host);
  assert.equal(ipc('getSettings').values.pageSize, 25);
  assert.equal(ipc('getSettings').origins.pageSize, 'default');
  assert.deepEqual(form(ipc('getSettings'), 'zh').find(row => row.key === 'pageSize'), { key: 'pageSize', label: '每页数量', value: 25 });
  assert.equal(form(host.get(), 'en').find(row => row.key === 'pageSize').label, 'Page size');
  assert.equal(JSON.parse(gateway({ method: 'updateSettings', args: [0, { pageSize: 10 }] })).ok, true);
  assert.equal(ipc('updateSettings', 0, { pageSize: 12 }).code, 'CONFLICT');
  for (const bad of [9, 101, 10.5, NaN, '25', null]) assert.equal(ipc('updateSettings', 1, { pageSize: bad }).code, 'INVALID');
  for (const bad of ['40px', '20.5', '1e2', '101', '', 'true', ' 40']) assert.equal(edit(host, 'pageSize', bad).ok, false);
  assert.equal(host.get().revision, 1);
  assert.equal(edit(host, 'pageSize', '100').ok, true);
  assert.equal(createHost(host.persist()).get().origins.pageSize, 'user');
  assert.deepEqual(host.persist().future, ['keep']);
  assert.equal(edit(host, 'verbose', 'true').snapshot.values.verbose, true);
});
