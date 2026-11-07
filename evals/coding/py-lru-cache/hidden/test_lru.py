import unittest
from lru import LRUCache
class T(unittest.TestCase):
    def test_evict(self):
        c = LRUCache(2); c.put('a', 1); c.put('b', 2); self.assertEqual(c.get('a'), 1)
        c.put('c', 3); self.assertIsNone(c.get('b')); self.assertEqual(c.get('a'), 1); self.assertEqual(c.get('c'), 3)
        self.assertEqual(len(c), 2)
    def test_update(self):
        c = LRUCache(2); c.put('a', 1); c.put('b', 2); c.put('a', 10); c.put('c', 3)
        self.assertEqual(c.get('a'), 10); self.assertIsNone(c.get('b'))
    def test_bad(self):
        with self.assertRaises(ValueError): LRUCache(0)
    def test_perf(self):
        import time, signal
        def too_slow(*_): raise TimeoutError('LRU operations are too slow')
        signal.signal(signal.SIGALRM, too_slow); signal.alarm(5)
        try:
            c = LRUCache(1000); t = time.time()
            for i in range(200000): c.put(i, i); c.get(i - 500)
        finally:
            signal.alarm(0)
        self.assertLess(time.time() - t, 2.0)
