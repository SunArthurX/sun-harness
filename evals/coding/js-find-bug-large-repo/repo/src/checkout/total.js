import { splitCents } from '../money/split.js';
export const installments = (total, n) => splitCents(total, n);
