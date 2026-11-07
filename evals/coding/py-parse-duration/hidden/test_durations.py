import unittest
from durations import parse_duration
class T(unittest.TestCase):
    def test_all(self):
        self.assertEqual(parse_duration('1h30m'), 5400)
        self.assertEqual(parse_duration('45s'), 45)
        self.assertEqual(parse_duration('1h2m3s'), 3723)
        self.assertEqual(parse_duration('2h'), 7200)
    def test_bad(self):
        for bad in ['', 'abc', '1x', 'h']:
            with self.assertRaises(ValueError):
                parse_duration(bad)
