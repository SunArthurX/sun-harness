export async function pool(tasks, limit) {
  return Promise.all(tasks.map((t) => t()));
}
