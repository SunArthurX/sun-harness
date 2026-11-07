#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > clean.py <<'EOF'
def dedupe(items):
    return list(dict.fromkeys(items))
EOF
