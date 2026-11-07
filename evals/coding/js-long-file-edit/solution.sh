#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
python3 - <<'EOF'
p='lib.js'; s=open(p).read()
s=s.replace('''  return values.reduce((a, b) => a + b, 0) / values.length;''','''  const ok = values.filter((v) => v >= 0);
  if (!ok.length) return 0;
  return Math.round((ok.reduce((a, b) => a + b, 0) / ok.length) * 10) / 10;''')
open(p,'w').write(s)
EOF
