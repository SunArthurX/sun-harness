import { notifyAll } from './notify/job.js';

export async function nightly(users, send) {
  console.log(`starting notify run (users=${users.length})`);
  return notifyAll(users, send);
}
