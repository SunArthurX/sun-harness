#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
python3 - <<'EOF'
p='config.js'; s=open(p).read()
i=s.index('production:'); j=s.index('retries: 3', i)
s=s[:j]+'retries: 5'+s[j+len('retries: 3'):]
open(p,'w').write(s)
EOF
