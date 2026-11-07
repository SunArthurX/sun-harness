#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > merge.py <<'EOF'
import copy

def deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if v is None:
            out.pop(k, None)
        elif isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out
EOF
