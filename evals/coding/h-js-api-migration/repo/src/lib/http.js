// New API. `request` is deprecated and must not be used any more.
const calls = [];
export function http({ url, method = 'GET', body = undefined, headers = {} } = {}) {
  if (!url) throw new TypeError('url is required');
  calls.push({ url, method, body, headers });
  return Promise.resolve({ ok: true, url, method, body });
}
export function __calls() {
  return calls;
}

/** @deprecated use http({ url, method, body }) */
export function request(url, method, body) {
  return http({ url, method: method ?? 'GET', body });
}
