import unittest, subprocess, sys, json
class T(unittest.TestCase):
    def test_out(self):
        out = subprocess.run([sys.executable, 'report.py'], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        d = json.loads(out.stdout)
        self.assertEqual(d, {'east': 99.9, 'north': 78.97, 'south': 64.46})
        self.assertEqual(list(d), sorted(d))
