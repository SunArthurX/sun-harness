import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderError, applyRuleBudgets, compactionLimit, contextWindowOf, homePath, loadProjectContext } from '../src/index.js';
import { mockHost, tempHome, tempWorkspace, testConfig } from './helpers.js';

const mockProvider = { type: 'openai' as const, baseUrl: '', models: ['big', 'small'], modelContext: { big: 1_000_000, small: 3_000 } };

describe('rule budgets', () => {
  beforeEach(() => tempHome());

  it('gives global and project rules separate budgets', () => {
    const out = applyRuleBudgets(
      [
        { source: 'g', text: 'G'.repeat(50), scope: 'global' },
        { source: 'p1', text: 'P'.repeat(80), scope: 'project' },
        { source: 'p2', text: 'Q'.repeat(80), scope: 'project' },
        { source: 'p3', text: 'R', scope: 'project' },
      ],
      { globalMaxChars: 100, projectMaxChars: 100 },
    );
    expect(out[0].text).toBe('G'.repeat(50));
    expect(out[1].text).toBe('P'.repeat(80));
    expect(out[2].text).toContain('truncated: 60 more chars over the project rules budget; read p2');
    expect(out[3].text).toContain('omitted');
  });

  it('a huge project AGENTS.md cannot evict the global rules', () => {
    const ws = tempWorkspace();
    writeFileSync(homePath('AGENTS.md'), 'GLOBAL-RULE');
    writeFileSync(join(ws, 'AGENTS.md'), 'x'.repeat(60_000));
    const ctx = loadProjectContext(ws, { globalMaxChars: 1000, projectMaxChars: 5000 });
    expect(ctx.rules[0]).toMatchObject({ scope: 'global', text: 'GLOBAL-RULE' });
    expect(ctx.rules[1].text.length).toBeLessThan(5200);
  });
});

describe('context windows', () => {
  it('resolves windows from config, built-ins, and defaults', () => {
    const cfg = testConfig({ providers: { ...testConfig().providers, mock: mockProvider } });
    expect(contextWindowOf(cfg, 'mock/small')).toBe(3000);
    expect(contextWindowOf(cfg, 'deepseek/deepseek-chat')).toBe(128_000);
    expect(contextWindowOf(cfg, 'openrouter/anthropic/claude-sonnet-4.5')).toBe(200_000);
    expect(contextWindowOf(cfg, 'ollama/llama3.1')).toBe(32_768);
    expect(compactionLimit(cfg, 'deepseek/deepseek-chat')).toBe(96_000); // 25% buffer
    expect(compactionLimit({ ...cfg, compaction: { ...cfg.compaction, buffer: '10%' } }, 'mock/small')).toBe(2700);
    expect(compactionLimit({ ...cfg, compaction: { ...cfg.compaction, thresholdTokens: 50_000 } }, 'mock/big')).toBe(50_000);
  });
});

describe('compact before downgrade', () => {
  let ws: string;
  beforeEach(() => {
    tempHome();
    ws = tempWorkspace();
  });

  const big = 'y'.repeat(6000);

  it('summarizes with the previous (larger) model before the smaller model sees the history', async () => {
    const { host, providers } = await mockHost(
      {
        'mock/big': [{ text: big, toolCalls: [] }, { text: big, toolCalls: [] }, { text: 'SUMMARY by big', toolCalls: [] }],
        'mock/small': [{ text: 'small answers', toolCalls: [] }],
      },
      { providers: { ...testConfig().providers, mock: mockProvider }, defaultModel: 'mock/big', compaction: { thresholdTokens: 200_000, keepRecent: 1, buffer: '25%' } },
    );
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'q1');
    await host.wait(s.id);
    await host.send(s.id, 'q2');
    await host.wait(s.id);
    host.switchModel(s.id, 'mock/small');
    await host.send(s.id, 'q3');
    await host.wait(s.id);
    const comp = host.getEvents(s.id).find((e) => e.type === 'context/compaction') as any;
    expect(comp).toMatchObject({ summary: 'SUMMARY by big', model: 'mock/big' });
    const smallReq = providers.get('mock/small')!.requests[0];
    expect(smallReq.messages.some((m) => m.content === big)).toBe(false);
    expect(smallReq.messages[0].content).toContain('SUMMARY by big');
  });

  it('falls back to the new model when the old one cannot summarize (quota)', async () => {
    const { host, providers } = await mockHost(
      {
        'mock/big': [{ text: big, toolCalls: [] }, { text: big, toolCalls: [] }, new ProviderError('quota', 'insufficient_quota', 429)],
        'mock/small': [{ text: 'SUMMARY by small', toolCalls: [] }, { text: 'done', toolCalls: [] }],
      },
      { providers: { ...testConfig().providers, mock: mockProvider }, defaultModel: 'mock/big', compaction: { thresholdTokens: 200_000, keepRecent: 1, buffer: '25%' } },
    );
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'q1');
    await host.wait(s.id);
    await host.send(s.id, 'q2');
    await host.wait(s.id);
    host.switchModel(s.id, 'mock/small');
    await host.send(s.id, 'q3');
    expect((await host.wait(s.id))?.status).toBe('idle');
    const comp = host.getEvents(s.id).find((e) => e.type === 'context/compaction') as any;
    expect(comp.summary).toBe('SUMMARY by small');
    expect(comp.model).toBeUndefined();
    // The trimmed transcript fits the small model's budget (limit 2250 tokens ≈ 6750 chars).
    expect(providers.get('mock/small')!.requests[0].messages[0].content.length).toBeLessThanOrEqual(6750);
  });

  it('does not compact on switch when the history fits the new model', async () => {
    const { host } = await mockHost(
      { 'mock/big': [{ text: 'short', toolCalls: [] }], 'mock/small': [{ text: 'ok', toolCalls: [] }] },
      { providers: { ...testConfig().providers, mock: mockProvider }, defaultModel: 'mock/big' },
    );
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'hi');
    await host.wait(s.id);
    host.switchModel(s.id, 'mock/small');
    await host.send(s.id, 'again');
    await host.wait(s.id);
    expect(host.getEvents(s.id).some((e) => e.type === 'context/compaction')).toBe(false);
  });
});

