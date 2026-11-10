import { randomUUID } from 'node:crypto';
import { assertRemotePin, fetchServerCert, remoteEndpoint, type RemoteEntry } from '@sun/core';
import type { CertificatePreview, ConfirmConnection } from '../shared/connections';

interface PendingPreview extends CertificatePreview {
  cert: string;
  expires: number;
}

export class ConnectionReview {
  private pending?: PendingPreview;
  private latest = 0;

  async preview(input: unknown): Promise<CertificatePreview> {
    const sequence = ++this.latest;
    this.pending = undefined;
    if (typeof input !== 'string' || input.length > 2048) throw new Error('INVALID_GATEWAY_ENDPOINT');
    const url = remoteEndpoint(input);
    if (!url.startsWith('https://')) throw new Error('INVALID_GATEWAY_ENDPOINT');
    const { cert, fingerprint } = await fetchServerCert(url);
    assertRemotePin({ url, fingerprint });
    if (sequence !== this.latest) throw new Error('GATEWAY_PREVIEW_EXPIRED');
    const id = randomUUID();
    this.pending = { id, url, fingerprint, cert, expires: Date.now() + 5 * 60_000 };
    return { id, url, fingerprint };
  }

  confirm(input: ConfirmConnection): RemoteEntry {
    const pending = this.pending;
    if (!pending || !input || pending.expires < Date.now() || pending.id !== input.id || pending.fingerprint !== input.fingerprint) {
      throw new Error('GATEWAY_PREVIEW_EXPIRED');
    }
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 64
      || typeof input.token !== 'string' || !/^[a-zA-Z0-9_-]{16,256}$/.test(input.token)) {
      throw new Error('INVALID_GATEWAY_CREDENTIAL');
    }
    assertRemotePin(pending);
    return { name: input.name.trim(), token: input.token, url: pending.url, fingerprint: pending.fingerprint, cert: pending.cert };
  }
}
