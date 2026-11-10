export function endpoints(host) {
  const call = (method, ...args) => {
    if (method === 'getSettings') return host.get();
    if (method === 'updateSettings') return host.update(...args);
    throw new Error('Unknown settings method');
  };
  return {
    ipc: (method, ...args) => call(method, ...args),
    gateway: (request) => JSON.stringify(call(request.method, ...request.args)),
  };
}
