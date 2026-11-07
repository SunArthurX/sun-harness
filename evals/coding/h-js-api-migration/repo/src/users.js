import { request } from './lib/http.js';

export const getUser = (id) => request(`/users/${id}`);
export const createUser = (u) => request('/users', 'POST', u);
