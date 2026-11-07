const db = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function save(record) {
  await sleep(Math.random() * 20);
  db.push(record);
}

export async function saveAll(records) {
  records.forEach(async (r) => {
    await save(r);
  });
}

export function count() {
  return db.length;
}
