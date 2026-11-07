import { createServer } from 'node:http';

export function makeServer() {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/hello') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('hi');
    }
    res.writeHead(404);
    res.end();
  });
}
