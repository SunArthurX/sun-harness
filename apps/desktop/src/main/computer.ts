import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { ComputerApp, ComputerControlItem, ComputerTarget, DesktopComputerAdapter } from '@sun/core';

interface Response {
  authorized: boolean;
  hostFront?: boolean;
  apps?: ComputerApp[];
  target?: ComputerTarget;
  text?: string;
  controls?: ComputerControlItem[];
  outcome?: 'applied' | 'refused';
}

function run(helper: string, request: object, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) return Promise.reject(new Error('COMPUTER_STOPPED'));
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    let bytes = 0;
    const output: Buffer[] = [];
    const stop = () => { child.kill('SIGKILL'); };
    const timeout = setTimeout(stop, 3000);
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 256 * 1024) stop();
      else output.push(chunk);
    });
    child.stdin.on('error', stop);
    child.on('error', () => reject(new Error('COMPUTER_ADAPTER_FAILED')));
    child.on('close', code => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', stop);
      if (code !== 0 || signal.aborted) return reject(new Error('COMPUTER_ADAPTER_FAILED'));
      try { resolve(JSON.parse(Buffer.concat(output).toString('utf8')) as Response); }
      catch { reject(new Error('COMPUTER_ADAPTER_FAILED')); }
    });
    child.stdin.end(JSON.stringify({ ...request, hostPid: process.pid }));
  });
}

export function macComputer(helper: string, hostId: string, privacy: () => { active: boolean; revision: number }): DesktopComputerAdapter {
  const inspect = async () => {
    const result = await run(helper, { command: 'inspect', hostId }, AbortSignal.timeout(3500));
    if (typeof result.authorized !== 'boolean' || !Array.isArray(result.apps)) throw new Error('COMPUTER_ADAPTER_FAILED');
    return { authorized: result.authorized, apps: result.apps };
  };
  const operation = async (command: string, args: object, signal: AbortSignal) => {
    const before = privacy();
    if (before.active) throw new Error('COMPUTER_PRIVATE_WINDOW');
    const result = await run(helper, { command, hostId, ...args }, signal);
    const after = privacy();
    if (after.active || before.revision !== after.revision) throw new Error('COMPUTER_PRIVATE_WINDOW');
    return result;
  };
  return {
    status() {
      if (process.platform !== 'darwin' || Number(process.getSystemVersion().split('.')[0]) < 13) {
        return { state: 'unavailable', reasonCode: 'COMPUTER_PLATFORM_UNSUPPORTED' };
      }
      try { accessSync(helper, constants.X_OK); }
      catch { return { state: 'unavailable', reasonCode: 'ADAPTER_MISSING' }; }
      if (privacy().active) return { state: 'unavailable', reasonCode: 'COMPUTER_PRIVATE_WINDOW' };
      return 'available';
    },
    inspect,
    async probe(signal) {
      const deadline = Date.now() + 6000;
      let result = await operation('probe', {}, signal);
      while (result.authorized && result.hostFront && Date.now() < deadline) {
        await delay(250, undefined, { signal });
        result = await operation('probe', {}, signal);
      }
      return { authorized: result.authorized === true, target: result.target };
    },
    async snapshot(target, signal) {
      const result = await operation('snapshot', { target }, signal);
      if (!result.authorized || !result.target || typeof result.text !== 'string' || !Array.isArray(result.controls)) throw new Error('COMPUTER_ADAPTER_FAILED');
      return { target: result.target, text: result.text, controls: result.controls };
    },
    async act(target, control, action, signal) {
      const { outcome } = await operation('act', { target, key: control.key, ...action }, signal);
      if (outcome !== 'applied' && outcome !== 'refused') throw new Error('COMPUTER_OUTCOME_UNCERTAIN');
      return outcome;
    },
  };
}
