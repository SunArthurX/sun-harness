import unittest, subprocess, tempfile, os
class T(unittest.TestCase):
    def test_spaces(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, 'my src'); dst = os.path.join(d, 'my dst'); os.makedirs(src)
            for n in ['a.txt', 'b c.txt', 'd  e.txt', 'skip.md']: open(os.path.join(src, n), 'w').write(n)
            out = subprocess.run(['bash', 'backup.sh', src, dst], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr); self.assertEqual(out.stdout.strip(), '3')
            self.assertEqual(sorted(os.listdir(dst)), ['a.txt', 'b c.txt', 'd  e.txt'])
    def test_missing_src(self):
        out = subprocess.run(['bash', 'backup.sh', '/nonexistent/dir', '/tmp/x-dst-eval'], capture_output=True, text=True)
        self.assertNotEqual(out.returncode, 0); self.assertTrue(out.stderr.strip())
