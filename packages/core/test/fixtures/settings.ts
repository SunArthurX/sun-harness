import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionLog } from '../../src/log.js';
import { homePath } from '../../src/paths.js';

export const fakeSecret = 'SUN_TEST_ONLY_SECRET_SENTINEL';

export const configFixtures = {
  minimal: '{}\n',
  legacy: JSON.stringify({
    defaultModel: 'fixture/model',
    providers: { fixture: { type: 'openai', baseUrl: 'https://fixture.invalid/v1', models: ['model'], noKey: true } },
    futureSetting: { preserve: ['untouched'] },
  }),
  invalidJson: '{"approval":',
  invalidValues: JSON.stringify({ approval: 'anything', maxSteps: -1 }),
  secretBearing: JSON.stringify({
    providers: {
      fixture: {
        type: 'openai',
        baseUrl: `https://fixture:${fakeSecret}@fixture.invalid/v1`,
        models: ['model'],
        apiKey: fakeSecret,
        headers: { Authorization: `Bearer ${fakeSecret}` },
      },
    },
  }),
};

export const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ2sAAAAASUVORK5CYII=',
  'base64',
);

export function sessionWithAttachment(workspace: string) {
  const log = SessionLog.create({ cwd: workspace, model: 'fixture/model', mode: 'coding' });
  const dir = homePath('attachments', log.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'fixture.png');
  writeFileSync(path, fixturePng);
  log.append({ type: 'user/message', text: 'Inspect the test window.', source: 'user', images: [{ path, mime: 'image/png' }] });
  return { id: log.id, path };
}

type NativeState = 'available' | 'denied' | 'unavailable';

/** Deterministic fixture for capture tests. The production adapter contract is defined in T03/T11. */
export class FakeWindowCapture {
  calls = 0;

  constructor(public state: NativeState = 'available') {}

  probe(): NativeState {
    return this.state;
  }

  async capture(signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.calls++;
    if (this.state !== 'available') throw new Error(this.state);
    return {
      appId: 'test.fixture.window',
      title: 'Fixture window',
      mime: 'image/png',
      bytes: Buffer.from(fixturePng),
      text: 'Fixture window content',
    };
  }
}
