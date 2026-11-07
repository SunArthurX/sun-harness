import { reserve, release } from '../inventory/store.js';
import { makeOrder } from './model.js';

const orders = new Map();

export function placeOrder(id, lines) {
  const order = makeOrder(id, lines);
  for (const l of order.lines) reserve(l.sku, l.qty);
  orders.set(id, order);
  return order;
}

export function cancelOrder(id) {
  const order = orders.get(id);
  if (!order || order.status !== 'open') return false;
  for (const l of order.lines) release(l.productId, l.qty);
  order.status = 'cancelled';
  return true;
}
