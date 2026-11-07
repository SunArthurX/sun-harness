import type { User } from './types.ts';

export function byName(users: User[], q: string): User[] {
  return users.filter((u) => u.fullname.toLowerCase().includes(q.toLowerCase()));
}
