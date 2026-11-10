import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SUN_HOME = mkdtempSync(join(tmpdir(), 'd14-'));
const root = '/Users/sunqingguang/Downloads/06.code/sun-harness/packages/core/dist/browser';
const { BrowserManager, DEFAULT_BROWSER } = await import(`${root}/browser.js`);
const { CdpConnection } = await import(`${root}/cdp.js`);

const origSend = CdpConnection.prototype.send;
CdpConnection.prototype.send = function (method, params, sid, t) {
  const start = Date.now();
  const p = origSend.call(this, method, params, sid, t);
  p.then(() => console.log(`  ok ${method} ${Date.now() - start}ms`), e => console.log(`  ERR ${method} ${Date.now() - start}ms ${e.message}`));
  return p;
};

const server = createServer((req, res) => { console.log('server hit', req.url); res.end('<title>x</title><p>hello</p>'); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/page`;
const mgr = new BrowserManager(() => DEFAULT_BROWSER);
const snap = mgr.permissions.snapshot();
console.log(mgr.permissions.update({ expectedRevision: snap.revision, origin: url, action: 'browse', decision: 'allow' }).ok);
try {
  const out = await mgr.navigate('s1', url);
  console.log('NAV OK', out.slice(0, 200));
} catch (e) {
  console.log('NAV FAIL', e.message);
}
await mgr.dispose?.();
server.close();
process.exit(0);
