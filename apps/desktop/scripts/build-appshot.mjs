import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

if (process.platform === 'darwin') {
  const desktop = join(import.meta.dirname, '..');
  const output = join(desktop, 'build', 'native');
  mkdirSync(output, { recursive: true });
  const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64';
  for (const [source, binary] of [['Appshot.swift', 'sun-appshot'], ['Computer.swift', 'sun-computer']]) {
    execFileSync('xcrun', ['swiftc', '-O', '-parse-as-library', '-target', `${architecture}-apple-macos13.0`,
      join(desktop, 'native', source), '-o', join(output, binary)], { stdio: 'inherit' });
  }
}
