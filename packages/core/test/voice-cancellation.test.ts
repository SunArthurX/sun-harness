import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptionRequests, transcribe } from '../src/assistant/voice.js';

describe('transcription cancellation', () => {
  it('honors cancellation arriving before the audio request', async () => {
    const requests = new TranscriptionRequests();
    const id = randomUUID();
    const task = vi.fn(async () => 'late');
    expect(requests.cancel(id)).toBe(true);
    await expect(requests.run(id, task)).rejects.toThrow('Transcription cancelled.');
    expect(task).not.toHaveBeenCalled();
  });

  it('aborts the active operation and suppresses a late reply', async () => {
    const requests = new TranscriptionRequests();
    const id = randomUUID();
    const reply = Promise.withResolvers<string>();
    let signal: AbortSignal | undefined;
    const pending = requests.run(id, control => {
      signal = control;
      return reply.promise;
    });
    expect(requests.cancel(id)).toBe(true);
    expect(signal?.aborted).toBe(true);
    reply.resolve('late');
    await expect(pending).rejects.toThrow('Transcription cancelled.');
    expect(requests.cancel('malformed')).toBe(false);
  });

  it('aborts an in-flight ASR HTTP request', async () => {
    const arrived = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      response.on('close', () => closed.resolve());
      request.resume();
      request.on('end', () => arrived.resolve());
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const requests = new TranscriptionRequests();
    try {
      const id = randomUUID();
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = requests.run(id, signal => transcribe(Buffer.from('ID3fixture'), 'audio/mpeg', { baseUrl, model: 'fixture-asr', signal }));
      const checked = expect(response).rejects.toThrow('Transcription cancelled.');
      await arrived.promise;
      requests.cancel(id);
      await checked;
      await closed.promise;
    } finally {
      requests.dispose();
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    }
  });
});
