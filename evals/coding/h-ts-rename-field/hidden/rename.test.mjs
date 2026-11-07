import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/index.ts';
test('displayName everywhere', () => { const u = m.createUser('Ada Lovelace', 'ada@example.com'); assert.equal(u.displayName, 'Ada Lovelace'); assert.equal(u.fullname, undefined);
  assert.equal(m.label(u), 'Ada Lovelace <ada@example.com>'); assert.equal(m.byName([u], 'ada').length, 1); });
test('wire compat', () => { const u = m.createUser('Grace', 'g@x.io'); const w = m.toWire(u); assert.equal(w.fullname, 'Grace'); assert.equal(w.displayName, undefined);
  assert.equal(m.fromWire({ id: 9, fullname: 'Linus', email: 'l@x.io' }).displayName, 'Linus'); });
