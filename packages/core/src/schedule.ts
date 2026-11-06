import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensureDir, homePath, sunHome } from './paths.js';

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  mode: string;
  cwd: string;
  /** One-shot ISO time. */
  at?: string;
  /** 5-field cron in local time: minute hour day-of-month month day-of-week. */
  cron?: string;
  enabled: boolean;
  lastRun?: string;
  createdAt: string;
}

function file(): string {
  ensureDir(sunHome());
  return homePath('schedules.json');
}

export function listSchedules(): ScheduledTask[] {
  if (!existsSync(file())) return [];
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    return [];
  }
}

export function saveSchedules(tasks: ScheduledTask[]): void {
  writeFileSync(file(), JSON.stringify(tasks, null, 2) + '\n');
}

export function addSchedule(t: Omit<ScheduledTask, 'id' | 'createdAt' | 'enabled'> & { enabled?: boolean }): ScheduledTask {
  if (!t.at && !t.cron) throw new Error('Provide "at" (ISO time) or "cron".');
  if (t.cron) parseCron(t.cron);
  if (t.at && Number.isNaN(Date.parse(t.at))) throw new Error(`Invalid time: ${t.at}`);
  const task: ScheduledTask = { ...t, id: randomUUID().slice(0, 8), enabled: t.enabled ?? true, createdAt: new Date().toISOString() };
  saveSchedules([...listSchedules(), task]);
  return task;
}

export function removeSchedule(id: string): void {
  saveSchedules(listSchedules().filter((t) => t.id !== id));
}

function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS ? Number(stepS) : 1;
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number);
      lo = a;
      hi = b ?? (stepS ? max : a);
    }
    if ([lo, hi, step].some((n) => Number.isNaN(n)) || lo < min || hi > max || step < 1) throw new Error(`Invalid cron field "${spec}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): (d: Date) => boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron needs 5 fields: "${expr}"`);
  const [mi, h, dom, mon, dow] = [field(parts[0], 0, 59), field(parts[1], 0, 23), field(parts[2], 1, 31), field(parts[3], 1, 12), field(parts[4], 0, 7)];
  if (dow.has(7)) dow.add(0);
  return (d) => mi.has(d.getMinutes()) && h.has(d.getHours()) && dom.has(d.getDate()) && mon.has(d.getMonth() + 1) && dow.has(d.getDay());
}

/** Tasks due at `now`, given each task's lastRun (minute granularity, catches up one-shot tasks that were missed). */
export function dueTasks(tasks: ScheduledTask[], now = new Date()): ScheduledTask[] {
  const minute = new Date(now);
  minute.setSeconds(0, 0);
  return tasks.filter((t) => {
    if (!t.enabled) return false;
    if (t.at) return !t.lastRun && Date.parse(t.at) <= now.getTime();
    if (t.cron) {
      if (t.lastRun && Date.parse(t.lastRun) >= minute.getTime()) return false;
      return parseCron(t.cron)(minute);
    }
    return false;
  });
}
