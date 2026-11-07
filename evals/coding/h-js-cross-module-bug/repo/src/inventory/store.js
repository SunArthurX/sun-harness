// In-memory stock levels and reservations, keyed by SKU.
const stock = new Map();
const reserved = new Map();

export function setStock(sku, qty) {
  stock.set(sku, qty);
  reserved.set(sku, 0);
}

export function available(sku) {
  return (stock.get(sku) ?? 0) - (reserved.get(sku) ?? 0);
}

export function reserve(sku, qty) {
  if (available(sku) < qty) throw new Error(`insufficient stock for ${sku}`);
  reserved.set(sku, (reserved.get(sku) ?? 0) + qty);
}

export function release(sku, qty) {
  reserved.set(sku, Math.max(0, (reserved.get(sku) ?? 0) - qty));
}
