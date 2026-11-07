import type { User } from './types.ts';

// The wire format keeps the legacy key `fullname`.
export function toWire(u: User): Record<string, unknown> {
  return { id: u.id, fullname: u.fullname, email: u.email };
}

export function fromWire(o: { id: number; fullname: string; email: string }): User {
  return { id: o.id, fullname: o.fullname, email: o.email };
}
