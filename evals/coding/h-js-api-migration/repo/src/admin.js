import * as h from './lib/http.js';

export const purge = () => h.request('/admin/purge', 'DELETE');
