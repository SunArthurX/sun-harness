import { request } from './lib/http.js';

export function listOrders() {
  return request('/orders');
}

export function cancel(id) {
  return request(`/orders/${id}/cancel`, 'POST');
}
