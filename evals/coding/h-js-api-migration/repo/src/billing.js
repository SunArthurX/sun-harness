import { request } from './lib/http.js';

export const charge = (amount) => request('/charges', 'POST', { amount });
export const refund = (id, amount) => request(`/charges/${id}/refund`, 'POST', { amount });
