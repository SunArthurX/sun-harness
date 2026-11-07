import { describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import { augmentPath, parseEnvLines } from '../src/index.js';

describe('PATH augmentation for GUI and launchd processes', () => {
  it('appends user tool dirs after the existing PATH, without duplicates', () => {
    const saved = process.env.PATH;
    try {
      process.env.PATH = '/usr/bin:/bin';
      const added = augmentPath();
      const parts = process.env.PATH!.split(':');
      expect(parts.slice(0, 2)).toEqual(['/usr/bin', '/bin']);
      expect(parts).toContain(dirname(process.execPath));
      expect(new Set(parts).size).toBe(parts.length);
      expect(augmentPath()).toEqual([]);
      expect(added.length).toBeGreaterThan(0);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('credential env import', () => {
  it('parses simple exports and skips anything that needs a shell', () => {
    const rc = [
      'export DEEPSEEK_API_KEY="sk-abc"',
      "export GLM_API_KEY='g-1'",
      'OPENAI_BASE_URL=https://x/v1  # comment',
      'export FROM_CMD=$(security find-generic-password -w)',
      'export WITH_VAR=$HOME/x',
      'eval "$(conda shell.zsh hook)"',
      'export PATH=/usr/bin',
    ].join('\n');
    expect(parseEnvLines(rc, (n) => /(_API_KEY|_BASE_URL)$/.test(n))).toEqual({
      DEEPSEEK_API_KEY: 'sk-abc',
      GLM_API_KEY: 'g-1',
      OPENAI_BASE_URL: 'https://x/v1',
    });
    expect(parseEnvLines(rc)).not.toHaveProperty('FROM_CMD');
    expect(parseEnvLines(rc)).not.toHaveProperty('WITH_VAR');
  });
});
