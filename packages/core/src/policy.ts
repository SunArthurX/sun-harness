import { isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ApprovalMode } from './config.js';
import { sunHome } from './paths.js';
import type { Tool } from './tools/types.js';

export function resolveIn(cwd: string, p: string): string {
  if (p.startsWith('~/')) p = homedir() + p.slice(1);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Decide whether a tool call needs a human decision.
 * - full-auto: never asks.
 * - auto-edit: asks for exec/network, and for writes outside the workspace or ~/.sun.
 * - suggest: asks for everything that is not a read.
 */
export function needsApproval(tool: Tool, args: Record<string, unknown>, mode: ApprovalMode, cwd: string): boolean {
  if (mode === 'full-auto') return false;
  if (tool.risk === 'read') return false;
  if (mode === 'suggest') return true;
  if (tool.risk === 'write') {
    const targets = tool.paths ? tool.paths(args) : tool.pathArg && typeof args[tool.pathArg] === 'string' ? [args[tool.pathArg] as string] : [];
    return targets.some((p) => {
      const abs = resolveIn(cwd, p);
      return !(isInside(cwd, abs) || isInside(sunHome(), abs));
    });
  }
  return true;
}
