import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface VoiceConfig {
  /** Speech-to-text model ref: a chat model that accepts input_audio (DashScope qwen3-asr-flash) or an OpenAI transcription model. */
  stt: string;
}

export const DEFAULT_VOICE: VoiceConfig = { stt: 'qwen/qwen3-asr-flash' };

/** Re-encode to 16 kHz mono MP3 with ffmpeg when available (browsers record webm/opus, which not every ASR accepts). */
export function toMp3(bytes: Buffer, mime: string): { bytes: Buffer; mime: string } {
  if (/mpeg|mp3/.test(mime)) return { bytes, mime: 'audio/mpeg' };
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return { bytes, mime };
  const dir = mkdtempSync(join(tmpdir(), 'sun-voice-'));
  try {
    const inp = join(dir, 'in');
    const out = join(dir, 'out.mp3');
    writeFileSync(inp, bytes);
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', inp, '-ar', '16000', '-ac', '1', out], { timeout: 60_000 });
    return r.status === 0 ? { bytes: readFileSync(out), mime: 'audio/mpeg' } : { bytes, mime };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function transcribe(audio: Buffer, mime: string, o: { baseUrl: string; apiKey?: string; model: string }): Promise<string> {
  const a = toMp3(audio, mime);
  const auth: Record<string, string> = o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {};
  const base = o.baseUrl.replace(/\/$/, '');
  if (/whisper|transcribe/i.test(o.model)) {
    const form = new FormData();
    form.append('model', o.model);
    form.append('file', new Blob([new Uint8Array(a.bytes)], { type: a.mime }), a.mime === 'audio/mpeg' ? 'audio.mp3' : 'audio.webm');
    const r = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: auth, body: form, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`Transcription failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
    return String(((await r.json()) as { text?: string }).text ?? '').trim();
  }
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ model: o.model, stream: false, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${a.mime};base64,${a.bytes.toString('base64')}` } }] }] }),
    signal: AbortSignal.timeout(120_000),
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
