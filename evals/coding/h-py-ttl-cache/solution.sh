#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > cache.py <<'EOF'
import functools
import time
from collections import OrderedDict


def ttl_cache(maxsize=128, ttl=60.0, clock=time.monotonic):
    def deco(fn):
        store = OrderedDict()
        stats = {'hits': 0, 'misses': 0}

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            key = (args, tuple(sorted(kwargs.items())))
            hash(key)
            now = clock()
            for k in [k for k, (_, exp) in store.items() if exp <= now]:
                del store[k]
            if key in store:
                stats['hits'] += 1
                store.move_to_end(key)
                return store[key][0]
            stats['misses'] += 1
            value = fn(*args, **kwargs)
            store[key] = (value, now + ttl)
            store.move_to_end(key)
            while len(store) > maxsize:
                store.popitem(last=False)
            return value

        wrapper.cache_info = lambda: {'hits': stats['hits'], 'misses': stats['misses'], 'size': len(store)}

        def clear():
            store.clear()
            stats['hits'] = stats['misses'] = 0

        wrapper.cache_clear = clear
        return wrapper

    return deco
EOF
