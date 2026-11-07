import { request as req } from './lib/http.js';

export const search = (q) => req(`/search?q=${encodeURIComponent(q)}`, 'GET');
