import unittest
from text_utils import slugify
class T(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify('Hello, World!'), 'hello-world')
        self.assertEqual(slugify('  --Already--slug--  '), 'already-slug')
        self.assertEqual(slugify('Crème Brûlée & Niño'), 'creme-brulee-nino')
        self.assertEqual(slugify('a' * 60), 'a' * 50)
        self.assertEqual(slugify('abc def ghi', max_length=8), 'abc-def')
        self.assertEqual(slugify('***'), '')
