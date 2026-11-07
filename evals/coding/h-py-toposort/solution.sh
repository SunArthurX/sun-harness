#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > toposort.py <<'EOF'
import heapq


class CycleError(Exception):
    def __init__(self, cycle):
        super().__init__(' -> '.join(cycle))
        self.cycle = cycle


def order(deps: dict) -> list:
    nodes = set(deps)
    for ds in deps.values():
        nodes.update(ds)
    graph = {n: set(deps.get(n, [])) for n in nodes}
    for n, ds in graph.items():
        if n in ds:
            raise CycleError([n, n])
    remaining = {n: len(ds) for n, ds in graph.items()}
    users = {n: [] for n in nodes}
    for n, ds in graph.items():
        for d in ds:
            users[d].append(n)
    ready = [n for n, c in remaining.items() if c == 0]
    heapq.heapify(ready)
    out = []
    while ready:
        n = heapq.heappop(ready)
        out.append(n)
        for u in users[n]:
            remaining[u] -= 1
            if remaining[u] == 0:
                heapq.heappush(ready, u)
    if len(out) == len(nodes):
        return out
    done = set(out)
    start = sorted(n for n in nodes if n not in done)[0]
    path, seen = [start], {start: 0}
    cur = start
    while True:
        nxt = sorted(d for d in graph[cur] if d not in done)[0]
        if nxt in seen:
            raise CycleError(path[seen[nxt]:] + [nxt])
        seen[nxt] = len(path)
        path.append(nxt)
        cur = nxt
EOF
