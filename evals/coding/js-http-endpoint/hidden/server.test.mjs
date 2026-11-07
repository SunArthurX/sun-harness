import { test } from 'node:test'; import assert from 'node:assert/strict';
import { makeServer } from '../server.js';
test('health', async () => { const s = makeServer().listen(0); const p = s.address().port;
  try { const r = await fetch(`http://127.0.0.1:${p}/health`); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /application\/json/);
    const b = await r.json(); assert.equal(b.status, 'ok'); assert.equal(typeof b.uptime, 'number');
    assert.equal((await fetch(`http://127.0.0.1:${p}/nope`)).status, 404); assert.equal(await (await fetch(`http://127.0.0.1:${p}/hello`)).text(), 'hi');
  } finally { s.close(); } });
