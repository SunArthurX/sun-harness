export type VoiceState = 'idle' | 'requesting' | 'recording' | 'transcribing';
export type VoiceIssue = 'denied' | 'unavailable' | 'failed';

interface VoiceDependencies {
  ask(): Promise<boolean>;
  open(): Promise<MediaStream>;
  record(stream: MediaStream): MediaRecorder;
  transcribe(data: string, mime: string, id: string): Promise<string>;
  cancel(id: string): Promise<unknown>;
  id(): string;
}

interface Recording {
  id: string;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  chunks: Blob[];
  submitted: boolean;
}

function stopTracks(stream?: MediaStream): void {
  stream?.getTracks().forEach(track => track.stop());
}

export class VoiceCapture {
  private active?: Recording;

  constructor(
    private readonly deps: VoiceDependencies,
    private readonly status: (state: VoiceState, issue?: VoiceIssue) => void,
    private readonly text: (value: string) => void,
  ) {}

  async start(): Promise<void> {
    if (this.active) return;
    const attempt: Recording = { id: this.deps.id(), chunks: [], submitted: false };
    this.active = attempt;
    this.status('requesting');
    try {
      const permission = await this.deps.ask();
      if (this.active !== attempt) return;
      if (!permission) {
        this.end(attempt, 'denied');
        return;
      }
      const stream = await this.deps.open();
      if (this.active !== attempt) {
        stopTracks(stream);
        return;
      }
      attempt.stream = stream;
      const recorder = this.deps.record(stream);
      attempt.recorder = recorder;
      recorder.ondataavailable = event => {
        if (this.active === attempt && event.data.size) attempt.chunks.push(event.data);
      };
      recorder.onstop = () => { void this.transcribe(attempt); };
      recorder.start();
      this.status('recording');
    } catch (error) {
      const name = (error as Error)?.name;
      this.end(attempt, name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'unavailable' : 'failed');
    }
  }

  finish(): void {
    const attempt = this.active;
    if (attempt?.recorder?.state !== 'recording') return;
    try { attempt.recorder.stop(); } catch { this.end(attempt, 'failed'); }
  }

  cancel(report = true): void {
    const attempt = this.active;
    if (!attempt) return;
    this.active = undefined;
    if (attempt.recorder) {
      attempt.recorder.onstop = null;
      attempt.recorder.ondataavailable = null;
      try {
        if (attempt.recorder.state !== 'inactive') attempt.recorder.stop();
      } catch {
        // Tracks still need to be released if recording already stopped.
      }
    }
    stopTracks(attempt.stream);
    attempt.chunks = [];
    if (attempt.submitted) void this.deps.cancel(attempt.id).catch(() => undefined);
    if (report) this.status('idle');
  }

  private end(attempt: Recording, issue?: VoiceIssue): void {
    if (this.active !== attempt) return;
    this.cancel(false);
    this.status('idle', issue);
  }

  private async transcribe(attempt: Recording): Promise<void> {
    if (this.active !== attempt) return;
    stopTracks(attempt.stream);
    attempt.stream = undefined;
    this.status('transcribing');
    try {
      const blob = new Blob(attempt.chunks, { type: attempt.recorder?.mimeType || 'audio/webm' });
      attempt.chunks = [];
      if (!blob.size) return this.end(attempt);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (this.active !== attempt) return;
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      attempt.submitted = true;
      const text = await this.deps.transcribe(btoa(binary), blob.type, attempt.id);
      attempt.submitted = false;
      if (this.active === attempt && text) this.text(text);
      this.end(attempt);
    } catch {
      attempt.submitted = false;
      this.end(attempt, 'failed');
    }
  }
}
