import unittest, copy
from merge import deep_merge
class T(unittest.TestCase):
    def test_merge(self):
        b = {'a': 1, 'n': {'x': 1, 'y': {'z': 1}}, 'l': [1, 2], 'gone': 5}
        o = {'n': {'y': {'w': 2}}, 'l': [3], 'gone': None, 'new': True}
        bb, oo = copy.deepcopy(b), copy.deepcopy(o)
        self.assertEqual(deep_merge(b, o), {'a': 1, 'n': {'x': 1, 'y': {'z': 1, 'w': 2}}, 'l': [3], 'new': True})
        self.assertEqual(b, bb); self.assertEqual(o, oo)
    def test_replace_dict_with_scalar(self):
        self.assertEqual(deep_merge({'a': {'b': 1}}, {'a': 2}), {'a': 2})
