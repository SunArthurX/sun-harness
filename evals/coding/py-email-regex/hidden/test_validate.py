import unittest
from validate import is_valid_email as v
class T(unittest.TestCase):
    def test_valid(self):
        for s in ['first.last+tag@sub.example.co.uk', 'A_B-c@ex-ample.com', 'x@y.io', 'user123@mail.example.org']:
            self.assertTrue(v(s), s)
    def test_invalid(self):
        for s in ['a@b', 'a..b@example.com', '@example.com', 'ab.example.com', 'a@-ex.com', 'a@ex-.com', 'a b@ex.com', 'a@ex..com', '.a@ex.com']:
            self.assertFalse(v(s), s)
