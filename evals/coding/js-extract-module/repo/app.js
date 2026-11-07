export function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

export function isWeekend(d) {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

export function nextBusinessDay(d) {
  let x = addDays(d, 1);
  while (isWeekend(x)) x = addDays(x, 1);
  return formatDate(x);
}
