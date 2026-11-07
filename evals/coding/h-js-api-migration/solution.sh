#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
python3 - <<'EOF'
p = 'src/lib/http.js'
s = open(p).read()
s = s[:s.index('/** @deprecated')].rstrip() + '\n'
s = s.replace("// New API. `request` is deprecated and must not be used any more.\n", '')
open(p, 'w').write(s)
open('src/users.js', 'w').write("import { http } from './lib/http.js';\n\nexport const getUser = (id) => http({ url: `/users/${id}` });\nexport const createUser = (u) => http({ url: '/users', method: 'POST', body: u });\n")
open('src/orders.js', 'w').write("import { http } from './lib/http.js';\n\nexport function listOrders() {\n  return http({ url: '/orders' });\n}\n\nexport function cancel(id) {\n  return http({ url: `/orders/${id}/cancel`, method: 'POST' });\n}\n")
open('src/billing.js', 'w').write("import { http } from './lib/http.js';\n\nexport const charge = (amount) => http({ url: '/charges', method: 'POST', body: { amount } });\nexport const refund = (id, amount) => http({ url: `/charges/${id}/refund`, method: 'POST', body: { amount } });\n")
open('src/search.js', 'w').write("import { http } from './lib/http.js';\n\nexport const search = (q) => http({ url: `/search?q=${encodeURIComponent(q)}`, method: 'GET' });\n")
open('src/admin.js', 'w').write("import * as h from './lib/http.js';\n\nexport const purge = () => h.http({ url: '/admin/purge', method: 'DELETE' });\n")
EOF
