#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > intervals.py <<'EOF'
def merge(intervals, merge_touching=False):
    items = []
    for s, e in intervals:
        if s > e:
            raise ValueError(f'invalid interval ({s}, {e})')
        items.append((s, e))
    items.sort()
    out = []
    for s, e in items:
        if out:
            ps, pe = out[-1]
            if s < pe or (merge_touching and s == pe):
                out[-1] = (ps, max(pe, e))
                continue
        out.append((s, e))
    return out
EOF
