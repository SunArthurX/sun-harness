import type { User } from './types.ts';

let next = 1;
export function createUser(fullname: string, email: string): User {
  return { id: next++, fullname, email };
}
