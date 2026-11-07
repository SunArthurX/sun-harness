import unittest
from toposort import order, CycleError
class T(unittest.TestCase):
    def test_order(self):
        self.assertEqual(order({'b': ['a'], 'c': ['a'], 'd': ['b', 'c']}), ['a', 'b', 'c', 'd'])
        self.assertEqual(order({'app': ['lib', 'util'], 'lib': ['util']}), ['util', 'lib', 'app'])
        self.assertEqual(order({}), []); self.assertEqual(order({'z': [], 'y': []}), ['y', 'z'])
    def test_cycle(self):
        with self.assertRaises(CycleError) as c: order({'a': ['b'], 'b': ['c'], 'c': ['a'], 'd': []})
        cyc = c.exception.cycle; self.assertEqual(cyc[0], cyc[-1]); self.assertEqual(sorted(set(cyc)), ['a', 'b', 'c']); self.assertEqual(len(cyc), 4)
        deps = {'a': ['b'], 'b': ['c'], 'c': ['a']}
        for x, y in zip(cyc, cyc[1:]): self.assertIn(y, deps[x])
        with self.assertRaises(CycleError) as c2: order({'s': ['s']})
        self.assertEqual(c2.exception.cycle, ['s', 's'])
