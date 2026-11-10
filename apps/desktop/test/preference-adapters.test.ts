import { describe, expect, it, vi } from 'vitest';
import { defaultUiPreferences } from '../../../packages/core/src/settings/preferences';
import { GlobalShortcutBinding } from '../src/main/shortcuts';
import { NotificationTracker } from '../src/renderer/src/notifications';
import { VoiceCapture } from '../src/renderer/src/voice-capture';
import type { SessionSummary } from '@sun/core';

describe('notification delivery', () => {
  const session = { id: 's', title: 'Session', status: 'running' } as SessionSummary;
  const prefs = defaultUiPreferences().notifications;

  it('seeds without alerting, deduplicates, and never replays a muted status', () => {
    const tracker = new NotificationTracker();
    tracker.seed([session]);
    const now = new Date('2026-01-12T03:00:00Z');
    const quietHours = { enabled: true, timeZone: 'America/New_York', start: '22:00', end: '07:00' };
    expect(tracker.accept('s', 4, 'awaiting_approval', { ...prefs, quietHours }, now)).toBeUndefined();
    expect(tracker.accept('s', 4, 'awaiting_approval', prefs, now)).toBeUndefined();
    expect(tracker.accept('s', 5, 'running', prefs, now)).toBeUndefined();
    expect(tracker.accept('s', 6, 'idle', prefs, now)).toBe('completion');
    expect(tracker.accept('s', 6, 'idle', prefs, now)).toBeUndefined();
    expect(tracker.accept('s', 5, 'paused', prefs, now)).toBeUndefined();
  });

  it('filters muted event types and subagent alerts', () => {
    const tracker = new NotificationTracker();
    tracker.seed([session, { ...session, id: 'child', parent: 's' }]);
    const now = new Date();
    expect(tracker.accept('child', 4, 'error', prefs, now)).toBeUndefined();
    expect(tracker.accept('s', 5, 'error', { ...prefs, failure: false }, now)).toBeUndefined();
    expect(tracker.accept('s', 6, 'paused', prefs, now)).toBe('pause');
  });
});

describe('global shortcut transaction', () => {
  it('keeps the prior shortcut after OS rejection and persistence rollback', () => {
    const callbacks = new Map<string, () => void>();
    const action = vi.fn();
    const binding = new GlobalShortcutBinding({
      register(key, run) {
        if (key === 'Ctrl+O') return false;
        callbacks.set(key, run);
        return true;
      },
      unregister(key) { callbacks.delete(key); },
    }, action);
    binding.prepare('Ctrl+M')!.commit();
    expect(binding.prepare('Ctrl+O')).toBeUndefined();
    expect(binding.active).toBe('Ctrl+M');
    const staged = binding.prepare('Ctrl+L')!;
    callbacks.get('Ctrl+L')!();
    expect(action).not.toHaveBeenCalled();
    staged.rollback();
    callbacks.get('Ctrl+M')!();
    expect(action).toHaveBeenCalledOnce();
    binding.prepare('Ctrl+L')!.commit();
    expect(callbacks.has('Ctrl+M')).toBe(false);
    expect(binding.active).toBe('Ctrl+L');
  });
});

function voiceFixture() {
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const recorder = {
    state: 'inactive' as RecordingState,
    mimeType: 'audio/webm',
    ondataavailable: null as ((event: BlobEvent) => void) | null,
    onstop: null as (() => void) | null,
    start() { this.state = 'recording'; },
    stop() { this.state = 'inactive'; this.onstop?.(); },
  };
  const deps = {
    ask: vi.fn(async () => true),
    open: vi.fn(async () => stream),
    record: () => recorder as unknown as MediaRecorder,
    transcribe: vi.fn(async () => 'transcript'),
    cancel: vi.fn(async () => undefined),
    id: () => 'request',
  };
  const status = vi.fn();
  const text = vi.fn();
  return { recorder, stopTrack, deps, status, text, capture: new VoiceCapture(deps, status, text) };
}

describe('voice capture', () => {
  it('honors microphone denial before opening the stream', async () => {
    const fixture = voiceFixture();
    fixture.deps.ask.mockResolvedValue(false);
    await fixture.capture.start();
    expect(fixture.deps.open).not.toHaveBeenCalled();
    expect(fixture.status).toHaveBeenLastCalledWith('idle', 'denied');
  });

  it('stops tracks and discards audio cancelled during recording', async () => {
    const fixture = voiceFixture();
    await fixture.capture.start();
    fixture.recorder.ondataavailable?.({ data: new Blob(['sample']) } as BlobEvent);
    fixture.capture.cancel();
    expect(fixture.stopTrack).toHaveBeenCalledOnce();
    expect(fixture.deps.transcribe).not.toHaveBeenCalled();
  });

  it('cancels a submitted request and ignores its late result', async () => {
    const fixture = voiceFixture();
    const response = Promise.withResolvers<string>();
    fixture.deps.transcribe.mockReturnValue(response.promise);
    await fixture.capture.start();
    fixture.recorder.ondataavailable?.({ data: new Blob(['sample']) } as BlobEvent);
    fixture.capture.finish();
    await vi.waitFor(() => expect(fixture.deps.transcribe).toHaveBeenCalledOnce());
    fixture.capture.cancel();
    response.resolve('late');
    await response.promise;
    expect(fixture.deps.cancel).toHaveBeenCalledWith('request');
    expect(fixture.text).not.toHaveBeenCalled();
  });
});
