// Split an amount (in cents) into n parts that add up exactly to the amount.
export function splitCents(total, n) {
  const part = Math.round(total / n);
  return Array.from({ length: n }, () => part);
}
