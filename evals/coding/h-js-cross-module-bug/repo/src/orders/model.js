// Order lines carry the product id; the catalog maps product ids to SKUs.
export function makeOrder(id, lines) {
  return { id, status: 'open', lines: lines.map((l) => ({ productId: l.productId, sku: l.sku, qty: l.qty })) };
}
