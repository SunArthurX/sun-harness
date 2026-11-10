import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { promisify } from 'node:util';
import { nativeImage } from 'electron';
import { APPSHOT_MAX_BYTES, type AppshotAdapter, type AppshotCapture, type AppshotEdits, type AppshotImage } from '@sun/core';

const run = promisify(execFile);

export function prepareAppshotImage(source: AppshotImage, edits: AppshotEdits): AppshotImage {
  const original = nativeImage.createFromBuffer(Buffer.from(source.data, 'base64'));
  const { width, height } = original.getSize();
  if (original.isEmpty() || width !== source.width || height !== source.height) throw new Error('APPSHOT_IMAGE_INVALID');
  const pixels = original.toBitmap();
  if (pixels.length !== width * height * 4) throw new Error('APPSHOT_IMAGE_INVALID');
  for (const rect of edits.masks) {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      const start = (y * width + rect.x) * 4;
      const end = start + rect.width * 4;
      pixels.fill(0, start, end);
      for (let offset = start + 3; offset < end; offset += 4) pixels[offset] = 255;
    }
  }
  const cleaned = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 });
  const cropped = edits.crop ? cleaned.crop(edits.crop) : cleaned;
  const size = cropped.getSize();
  const png = cropped.toPNG();
  if (png.length <= APPSHOT_MAX_BYTES) return { ...size, mime: 'image/png', data: png.toString('base64') };
  const jpeg = cropped.toJPEG(85);
  if (!jpeg.length || jpeg.length > APPSHOT_MAX_BYTES) throw new Error('APPSHOT_IMAGE_INVALID');
  return { ...size, mime: 'image/jpeg', data: jpeg.toString('base64') };
}

export function macAppshots(helper: string, enabled: () => boolean,
  privacy: () => { active: boolean; revision: number }): AppshotAdapter {
  return {
    status() {
      if (process.platform !== 'darwin' || Number(process.getSystemVersion().split('.')[0]) < 13) {
        return { state: 'unavailable', reasonCode: 'APPSHOT_PLATFORM_UNSUPPORTED' };
      }
      try { accessSync(helper, constants.X_OK); }
      catch { return { state: 'unavailable', reasonCode: 'ADAPTER_MISSING' }; }
      if (privacy().active) return { state: 'disabled', reasonCode: 'APPSHOT_PRIVATE_WINDOW' };
      return enabled() ? 'available' : { state: 'disabled', reasonCode: 'APPSHOT_DISABLED' };
    },
    async capture(scope) {
      const before = privacy();
      if (before.active) throw new Error('APPSHOT_CAPTURE_FAILED');
      try {
        const args = scope === 'own-app' ? ['capture', String(process.pid)] : ['capture'];
        const { stdout } = await run(helper, args, {
          timeout: 15_000, maxBuffer: Math.ceil(APPSHOT_MAX_BYTES / 3) * 4 + 256 * 1024,
        });
        const after = privacy();
        if (after.active || after.revision !== before.revision) throw new Error('APPSHOT_CAPTURE_FAILED');
        return JSON.parse(stdout) as AppshotCapture;
      } catch (error) {
        const diagnostic = String((error as { stderr?: string })?.stderr ?? '').trim();
        const code = /APPSHOT_(SCREEN_PERMISSION|NO_WINDOW|FOREGROUND_CHANGED|WINDOW_UNAVAILABLE|IMAGE_INVALID|CAPTURE_FAILED)$/.exec(diagnostic)?.[0];
        throw new Error(code ?? 'APPSHOT_CAPTURE_FAILED');
      }
    },
    async render(source, edits) { return prepareAppshotImage(source, edits); },
  };
}
