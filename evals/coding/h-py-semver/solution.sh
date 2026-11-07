#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > semver.py <<'EOF'
import re

V = re.compile(r'^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$')


def parse(v):
    m = V.match(v.strip())
    if not m:
        raise ValueError(f'invalid version: {v!r}')
    pre = tuple(m.group(4).split('.')) if m.group(4) else ()
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))), pre


def cmp_pre(a, b):
    if a == b:
        return 0
    if not a:
        return 1
    if not b:
        return -1
    for x, y in zip(a, b):
        if x == y:
            continue
        xn, yn = x.isdigit(), y.isdigit()
        if xn and yn:
            return -1 if int(x) < int(y) else 1
        if xn:
            return -1
        if yn:
            return 1
        return -1 if x < y else 1
    return -1 if len(a) < len(b) else 1


def cmp(a, b):
    if a[0] != b[0]:
        return -1 if a[0] < b[0] else 1
    return cmp_pre(a[1], b[1])


def expand(token):
    t = token.strip()
    if t in ('*', 'x', 'X', ''):
        return [('>=', ((0, 0, 0), ()))]
    for op in ('>=', '<=', '>', '<', '='):
        if t.startswith(op):
            return [(op, parse(t[len(op):]))]
    if t.startswith('^'):
        (ma, mi, pa), pre = parse(t[1:])
        up = (ma + 1, 0, 0) if ma else (0, mi + 1, 0) if mi else (0, 0, pa + 1)
        return [('>=', ((ma, mi, pa), pre)), ('<', (up, ()))]
    if t.startswith('~'):
        (ma, mi, pa), pre = parse(t[1:])
        return [('>=', ((ma, mi, pa), pre)), ('<', ((ma, mi + 1, 0), ()))]
    parts = t.split('.')
    if any(p in ('x', 'X', '*') for p in parts) or len(parts) < 3:
        nums = [int(p) for p in parts if p not in ('x', 'X', '*')]
        if len(nums) == 1:
            return [('>=', ((nums[0], 0, 0), ())), ('<', ((nums[0] + 1, 0, 0), ()))]
        if len(nums) == 2:
            return [('>=', ((nums[0], nums[1], 0), ())), ('<', ((nums[0], nums[1] + 1, 0), ()))]
        return [('>=', ((0, 0, 0), ()))]
    return [('=', parse(t))]


def test_set(ver, comps):
    for op, c in comps:
        r = cmp(ver, c)
        ok = {'=': r == 0, '>': r > 0, '>=': r >= 0, '<': r < 0, '<=': r <= 0}[op]
        if not ok:
            return False
    if ver[1]:
        return any(c[1] and c[0] == ver[0] for _, c in comps)
    return True


def satisfies(version: str, rng: str) -> bool:
    ver = parse(version)
    for part in rng.split('||'):
        comps = [c for tok in part.split() for c in expand(tok)] or expand('*')
        if test_set(ver, comps):
            return True
    return False
EOF
