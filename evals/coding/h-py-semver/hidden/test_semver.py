import unittest
from semver import satisfies as s
class T(unittest.TestCase):
    def test_exact_and_cmp(self):
        self.assertTrue(s('1.2.3', '1.2.3')); self.assertTrue(s('1.2.3', '=1.2.3')); self.assertFalse(s('1.2.4', '1.2.3'))
        self.assertTrue(s('2.0.0', '>1.9.9')); self.assertFalse(s('1.0.0', '<1.0.0')); self.assertTrue(s('1.5.0', '>=1.2.0 <2.0.0'))
    def test_caret_tilde(self):
        self.assertTrue(s('1.9.9', '^1.2.3')); self.assertFalse(s('2.0.0', '^1.2.3')); self.assertFalse(s('1.2.2', '^1.2.3'))
        self.assertTrue(s('0.2.9', '^0.2.3')); self.assertFalse(s('0.3.0', '^0.2.3')); self.assertTrue(s('0.0.3', '^0.0.3')); self.assertFalse(s('0.0.4', '^0.0.3'))
        self.assertTrue(s('1.2.9', '~1.2.3')); self.assertFalse(s('1.3.0', '~1.2.3'))
    def test_x_and_or(self):
        self.assertTrue(s('1.2.7', '1.2.x')); self.assertFalse(s('1.3.0', '1.2.x')); self.assertTrue(s('1.9.0', '1.x')); self.assertTrue(s('5.0.0', '*'))
        self.assertTrue(s('3.1.0', '^1.0.0 || ^3.0.0')); self.assertFalse(s('2.1.0', '^1.0.0 || ^3.0.0'))
    def test_prerelease(self):
        self.assertFalse(s('1.0.0-alpha', '>=0.9.0')); self.assertTrue(s('1.0.0-beta', '>=1.0.0-alpha'))
        self.assertFalse(s('1.0.0-alpha', '>=1.0.0')); self.assertTrue(s('1.0.0-alpha.10', '>1.0.0-alpha.2'))
        self.assertTrue(s('1.0.0-beta', '>1.0.0-alpha')); self.assertFalse(s('1.0.1-alpha', '>=1.0.0-alpha <2.0.0'))
    def test_invalid(self):
        for bad in ['1.2', 'a.b.c', '1.2.3.4', '']:
            with self.assertRaises(ValueError): s(bad, '*')
