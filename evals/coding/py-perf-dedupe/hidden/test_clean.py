import signal
import time
import unittest

from clean import dedupe


def _too_slow(*_):
    raise TimeoutError('dedupe is too slow')


class T(unittest.TestCase):
    def test_order(self):
        self.assertEqual(dedupe([3, 1, 3, 2, 1]), [3, 1, 2])
        self.assertEqual(dedupe([]), [])
        self.assertEqual(dedupe(['b', 'a', 'b']), ['b', 'a'])

    def test_fast(self):
        signal.signal(signal.SIGALRM, _too_slow)
        signal.alarm(3)
        try:
            data = list(range(100000)) * 2
            t = time.time()
            r = dedupe(data)
        finally:
            signal.alarm(0)
        self.assertEqual(len(r), 100000)
        self.assertLess(time.time() - t, 1.0)
