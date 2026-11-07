import unittest, subprocess, sys
class T(unittest.TestCase):
    def test_run(self):
        out = subprocess.run([sys.executable, '-m', 'shop.main'], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr); self.assertEqual(out.stdout.strip(), '11.25')
    def test_import(self):
        from shop.pricing import order_total
        from shop.models import Line
        self.assertEqual(order_total([Line('x', 1.0, 3)]), 3.0)
