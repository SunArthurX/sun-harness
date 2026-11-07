import type { User } from './types.ts';

export const sortByName = (users: User[]): User[] => [...users].sort((a, b) => a.fullname.localeCompare(b.fullname));
