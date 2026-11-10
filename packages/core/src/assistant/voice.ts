import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface VoiceConfig {
  enabled?: boolean;
  /** Speech-to-text model ref: a chat model that accepts input_audio (DashScope qwen3-asr-flash) or an OpenAI transcription model. */
  stt: string;
}

export const DEFAULT_VOICE: VoiceConfig = { enabled: true, stt: 'qwen/qwen3-asr-flash' };

const runFfmpeg = promisify(execFile);

/** Re-encode browser audio without blocking cancellation during conversion. */
export async function toMp3(bytes: Buffer, mime: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
  signal?.throwIfAborted();
  if (/mpeg|mp3/.test(mime)) return { bytes, mime };
  const dir = mkdtempSync(join(tmpdir(), 'sun-voice-'));
  try {
    const inp = join(dir, 'in');
    const out = join(dir, 'out.mp3');
    writeFileSync(inp, bytes);
    await runFfmpeg('ffmpeg', ['-y', '-loglevel', 'error', '-i', inp, '-ar', '16000', '-ac', '1', out], { timeout: 60_000, signal });
    return { bytes: readFileSync(out), mime: 'audio/mpeg' };
  } catch {
    signal?.throwIfAborted();
    return { bytes, mime };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const validRequestId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

/** Track voice requests across IPC and HTTP, including cancellation that arrives first. */
export class TranscriptionRequests {
  private readonly active = new Map<string, AbortController>();
  private readonly cancelled = new Map<string, number>();

  async run<T>(id: string | undefined, task: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    if (id === undefined) return task();
    if (!validRequestId(id)) throw new Error('Invalid transcription request ID.');
    if (this.active.has(id)) throw new Error('Transcription request is already active.');
    if ((this.cancelled.get(id) ?? 0) > Date.now()) throw new Error('Transcription cancelled.');
    if (this.active.size >= 32) throw new Error('Too many active transcription requests.');
    const control = new AbortController();
    this.active.set(id, control);
    try {
      const result = await task(control.signal);
      control.signal.throwIfAborted();
      return result;
    } finally {
      this.active.delete(id);
    }
  }

  cancel(id: unknown): boolean {
    if (!validRequestId(id)) return false;
    this.active.get(id)?.abort(new Error('Transcription cancelled.'));
    this.cancelled.delete(id);
    this.cancelled.set(id, Date.now() + 120_000);
    if (this.cancelled.size > 512) this.cancelled.delete(this.cancelled.keys().next().value!);
    return true;
  }

  dispose(): void {
    for (const control of this.active.values()) control.abort(new Error('Transcription cancelled.'));
    this.cancelled.clear();
  }
}

export async function transcribe(audio: Buffer, mime: string, o: { baseUrl: string; apiKey?: string; model: string; signal?: AbortSignal }): Promise<string> {
  const deadline = AbortSignal.timeout(120_000);
  const signal = o.signal ? AbortSignal.any([o.signal, deadline]) : deadline;
  const a = await toMp3(audio, mime, signal);
  signal.throwIfAborted();
  const auth: Record<string, string> = o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {};
  const base = o.baseUrl.replace(/\/$/, '');
  if (/whisper|transcribe/i.test(o.model)) {
    const form = new FormData();
    form.append('model', o.model);
    form.append('file', new Blob([new Uint8Array(a.bytes)], { type: a.mime }), a.mime === 'audio/mpeg' ? 'audio.mp3' : 'audio.webm');
    const r = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: auth, body: form, signal });
    if (!r.ok) throw new Error(`Transcription failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
    return String(((await r.json()) as { text?: string }).text ?? '').trim();
  }
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ model: o.model, stream: false, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${a.mime};base64,${a.bytes.toString('base64')}` } }] }] }),
    signal,
  });
  if (!r.ok) throw new Error(`Transcription failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return String(j.choices?.[0]?.message?.content ?? '').trim();
}

/** Record from the default microphone with ffmpeg (macOS avfoundation, Linux pulse/alsa). */
export function recordMic(seconds: number): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'sun-mic-'));
  try {
    const out = join(dir, 'mic.mp3');
    const input = process.platform === 'darwin' ? ['-f', 'avfoundation', '-i', ':0'] : ['-f', 'pulse', '-i', 'default'];
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-t', String(seconds), '-ar', '16000', '-ac', '1', out], { stdio: ['ignore', 'ignore', 'pipe'], timeout: (seconds + 15) * 1000 });
    if (r.status !== 0) throw new Error(`Recording failed: ${r.stderr?.toString().trim().slice(0, 300) || 'ffmpeg error'} (is ffmpeg installed and microphone access allowed?)`);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
