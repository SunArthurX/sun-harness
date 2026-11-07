import unittest
from cache import ttl_cache
class Clock:
    def __init__(self): self.t = 0.0
    def __call__(self): return self.t
class T(unittest.TestCase):
    def test_hits_ttl(self):
        clk = Clock(); calls = []
        @ttl_cache(maxsize=10, ttl=5, clock=clk)
        def f(x, y=0):
            "doc"
            calls.append((x, y)); return x + y
        self.assertEqual(f(1, y=2), 3); self.assertEqual(f(1, y=2), 3); self.assertEqual(len(calls), 1)
        clk.t = 4.9; f(1, y=2); self.assertEqual(len(calls), 1)
        clk.t = 5.1; f(1, y=2); self.assertEqual(len(calls), 2)
        self.assertEqual(f.__name__, 'f'); self.assertEqual(f.__doc__, 'doc')
        info = f.cache_info(); self.assertEqual((info['hits'], info['misses']), (2, 2)); self.assertEqual(info['size'], 1)
    def test_kwargs_order_lru_clear(self):
        clk = Clock(); calls = []
        @ttl_cache(maxsize=2, ttl=100, clock=clk)
        def g(**kw): calls.append(kw); return sorted(kw.items())
        g(a=1, b=2); g(b=2, a=1); self.assertEqual(len(calls), 1)
        g(a=2); g(a=1, b=2); g(a=3)
        g(a=2); self.assertEqual(len(calls), 4)
        g.cache_clear(); self.assertEqual(g.cache_info()['size'], 0); g(a=3); self.assertEqual(len(calls), 5)
    def test_unhashable(self):
        @ttl_cache()
        def h(x): return x
        with self.assertRaises(TypeError): h([1, 2])
