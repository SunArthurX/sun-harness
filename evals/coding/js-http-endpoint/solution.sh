#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
python3 - <<'PY'
p = 'server.js'
s = open(p).read()
s = s.replace("res.writeHead(404);", """if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    }
    res.writeHead(404);""", 1)
open(p, 'w').write(s)
PY
