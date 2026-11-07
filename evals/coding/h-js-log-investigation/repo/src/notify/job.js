import { normalizeEmail } from './email.js';

export async function notifyAll(users, send) {
  let sent = 0;
  const skipped = 0;
  for (const u of users) {
    // Every user gets the nightly digest.
    const to = u.profile.email;
    await send(normalizeEmail(to));
    sent++;
  }
  return { sent, skipped };
}
