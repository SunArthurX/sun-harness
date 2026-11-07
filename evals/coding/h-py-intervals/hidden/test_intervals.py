import unittest
from intervals import merge
class T(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(merge([(5, 7), (1, 3), (2, 4)]), [(1, 4), (5, 7)])
        self.assertEqual(merge([]), [])
        self.assertEqual(merge([(1, 10), (2, 3), (4, 5)]), [(1, 10)])
    def test_touching(self):
        self.assertEqual(merge([(1, 2), (2, 3)]), [(1, 2), (2, 3)])
        self.assertEqual(merge([(1, 2), (2, 3)], merge_touching=True), [(1, 3)])
    def test_zero_length(self):
        self.assertEqual(merge([(3, 3), (1, 2)]), [(1, 2), (3, 3)])
        self.assertEqual(merge([(1, 5), (3, 3)]), [(1, 5)])
        self.assertEqual(merge([(1, 5), (5, 5)]), [(1, 5), (5, 5)])
        self.assertEqual(merge([(1, 5), (5, 5)], merge_touching=True), [(1, 5)])
    def test_negative_float_and_immutability(self):
        data = [(-1.5, 0), (-3, -2), (0, 0.5)]; copy = list(data)
        self.assertEqual(merge(data, merge_touching=True), [(-3, -2), (-1.5, 0.5)]); self.assertEqual(data, copy)
    def test_invalid(self):
        with self.assertRaises(ValueError): merge([(3, 1)])
