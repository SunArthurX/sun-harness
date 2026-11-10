import { lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homePath } from './paths.js';

/** Accept regular files under owned session attachment directories, without following links inside those roots. */
export function ownedAttachment(path: string): string | undefined {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return;
  const abs = resolve(path);
  for (const [root, nested] of [[resolve(homePath('attachments')), false], [resolve(homePath('sessions')), true]] as const) {
    const parts = relative(root, abs).split(sep);
    if (parts.length !== (nested ? 3 : 2) || (nested && parts[1] !== 'attachments')) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(parts[0])) continue;
    if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
    if (!lstatSync(join(root, parts[0]), { throwIfNoEntry: false })?.isDirectory()) continue;
    if (nested && !lstatSync(join(root, parts[0], 'attachments'), { throwIfNoEntry: false })?.isDirectory()) continue;
    if (lstatSync(abs, { throwIfNoEntry: false })?.isFile()) return abs;
  }
}
