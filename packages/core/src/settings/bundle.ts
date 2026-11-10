import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { imageMime } from '../ux/mentions.js';
import { record } from './schema.js';

import { BUNDLE_MAX_BYTES, BUNDLE_MAX_COMPRESSED_BYTES } from './protocol.js';

export { BUNDLE_MAX_BYTES, BUNDLE_MAX_COMPRESSED_BYTES };
export const BUNDLE_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const BUNDLE_MAX_ENTRIES = 10_000;
const MAX_MANIFEST = 2 * 1024 * 1024;
const MAGIC = Buffer.from('SUNB1\n');
const HEADER_SIZE = MAGIC.length + 4;

interface Entry {
  name: string;
  size: number;
  sha256: string;
}

export function imageSignature(bytes: Buffer, mime: string): boolean {
  switch (mime) {
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
    case 'image/jpeg': return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif': return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
    case 'image/webp': return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    default: return false;
  }
}

function entryName(name: string, index: number): boolean {
  if (!index) return name === 'session.jsonl';
  return /^attachments\/[a-z0-9-]{1,64}\.(?:png|jpe?g|gif|webp)$/.test(name);
}

function validateManifest(manifest: unknown, manifestSize: number): Entry[] {
  if (!record(manifest) || Object.keys(manifest).length !== 2 || manifest.version !== 1
    || !Array.isArray(manifest.entries) || !manifest.entries.length || manifest.entries.length > BUNDLE_MAX_ENTRIES) {
    throw new Error('Invalid or unsupported session bundle manifest.');
  }
  const seen = new Set<string>();
  let total = HEADER_SIZE + manifestSize;
  return manifest.entries.map((entry: unknown, index: number) => {
    if (!record(entry) || Object.keys(entry).length !== 3 || typeof entry.name !== 'string'
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid session bundle entry.');
    if (seen.has(entry.name)) throw new Error('Duplicate session bundle path.');
    if (!entryName(entry.name, index)) throw new Error('Invalid session bundle path.');
    seen.add(entry.name);
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 1
      || (index > 0 && entry.size > BUNDLE_MAX_ATTACHMENT_BYTES)) throw new Error('Invalid session bundle entry size.');
    total += entry.size;
    if (total > BUNDLE_MAX_BYTES) throw new Error('Session bundle exceeds the inflated size limit.');
    return { name: entry.name, sha256: entry.sha256, size: entry.size };
  });
}

class BundleReader {
  private chunk: Buffer = Buffer.alloc(0);
  private inflated = 0;

  constructor(private readonly input: AsyncIterator<Buffer>) {}

  async hasBytes(): Promise<boolean> {
    while (!this.chunk.length) {
      const next = await this.input.next();
      if (next.done) return false;
      this.chunk = next.value;
      this.inflated += this.chunk.length;
      if (this.inflated > BUNDLE_MAX_BYTES) throw new Error('Session bundle exceeds the inflated size limit.');
    }
    return true;
  }

  async *take(size: number): AsyncGenerator<Buffer> {
    let remaining = size;
    while (remaining) {
      if (!await this.hasBytes()) throw new Error('Truncated session bundle.');
      const part = this.chunk.subarray(0, remaining);
      this.chunk = this.chunk.subarray(part.length);
      remaining -= part.length;
      yield part;
    }
  }

  async read(size: number): Promise<Buffer> {
    const result = Buffer.alloc(size);
    let offset = 0;
    for await (const piece of this.take(size)) {
      piece.copy(result, offset);
      offset += piece.length;
    }
    return result;
  }
}

async function* boundedCompressed(input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let bytes = 0;
  for await (const chunk of input) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Session bundle stream must contain bytes.');
    bytes += chunk.byteLength;
    if (bytes > BUNDLE_MAX_COMPRESSED_BYTES) throw new Error('Session bundle exceeds the compressed size limit.');
    yield chunk;
  }
}

/** Validate all names and declared sizes before writing payloads to a private stage. */
export async function unpackBundle(input: AsyncIterable<Uint8Array>, staging: string): Promise<Map<string, string>> {
  const inflated = createGunzip();
  const finished = pipeline(Readable.from(boundedCompressed(input), { objectMode: false }), inflated)
    .then(() => undefined, (error: unknown) => error);
  const reader = new BundleReader(inflated[Symbol.asyncIterator]());
  try {
    const header = await reader.read(HEADER_SIZE);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid session bundle header.');
    const size = header.readUInt32BE(MAGIC.length);
    if (!size || size > MAX_MANIFEST) throw new Error('Invalid session bundle manifest size.');
    const raw = await reader.read(size);
    let manifest: unknown;
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { throw new Error('Invalid session bundle manifest JSON.'); }
    const entries = validateManifest(manifest, size);
    const attachments = new Map<string, string>();
    if (entries.length > 1) await mkdir(join(staging, 'attachments'), { mode: 0o700 });
    for (const entry of entries) {
      const mime = imageMime(entry.name);
      const prefix = await reader.read(mime ? Math.min(entry.size, 12) : 0);
      if (mime && !imageSignature(prefix, mime)) throw new Error('Invalid session bundle attachment image data.');
      const file = await open(join(staging, entry.name), 'wx', 0o600);
      try {
        const hash = createHash('sha256').update(prefix);
        if (prefix.length) await file.writeFile(prefix);
        for await (const chunk of reader.take(entry.size - prefix.length)) {
          hash.update(chunk);
          await file.writeFile(chunk);
        }
        if (hash.digest('hex') !== entry.sha256) throw new Error('Session bundle entry digest mismatch.');
        await file.sync();
      } finally {
        await file.close();
      }
      if (mime) attachments.set(entry.name, mime);
    }
    if (await reader.hasBytes()) throw new Error('Trailing data in session bundle.');
    const failure = await finished;
    if (failure) throw failure;
    return attachments;
  } finally {
    inflated.destroy();
    await finished;
  }
}

export function packBundle(payloads: ReadonlyMap<string, Buffer>): Readable {
  const entries = [...payloads].map(([name, bytes]) => ({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
  const document = { version: 1, entries };
  const manifest = Buffer.from(JSON.stringify(document));
  if (manifest.length > MAX_MANIFEST) throw new Error('Session bundle manifest exceeds the size limit.');
  validateManifest(document, manifest.length);
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header);
  header.writeUInt32BE(manifest.length, MAGIC.length);
  function* chunks() {
    yield header;
    yield manifest;
    yield* payloads.values();
  }
  return Readable.from(chunks(), { objectMode: false }).pipe(createGzip());
}
