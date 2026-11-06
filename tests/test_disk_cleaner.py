import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from diskcleaner import scanner  # noqa: E402
from diskcleaner.layout import squarify  # noqa: E402


class SquarifyTest(unittest.TestCase):
    def test_covers_rectangle_without_overlap(self):
        sizes = [50, 30, 10, 6, 4]
        rects = squarify(sizes, 0, 0, 400, 300)
        self.assertEqual(len(rects), len(sizes))
        self.assertAlmostEqual(sum(w * h for _, _, _, w, h in rects), 400 * 300, places=3)
        for i, x, y, w, h in rects:
            self.assertGreaterEqual(x, -1e-6)
            self.assertLessEqual(x + w, 400 + 1e-6)
            self.assertLessEqual(y + h, 300 + 1e-6)
            self.assertAlmostEqual(w * h / (400 * 300), sizes[i] / sum(sizes), places=6)

    def test_empty(self):
        self.assertEqual(squarify([], 0, 0, 10, 10), [])
        self.assertEqual(squarify([5], 0, 0, 0, 10), [])


class DuplicateTest(unittest.TestCase):
    def test_same_content_found_same_size_different_content_not(self):
        with tempfile.TemporaryDirectory() as d:
            def mk(name, data):
                p = os.path.join(d, name)
                with open(p, 'wb') as f:
                    f.write(data)
                return {'p': p, 'size': len(data), 'mtime': 0}
            head = b'x' * 70000  # lớn hơn 64 KB để kiểm tra bước hash toàn bộ
            rows = [mk('a', head + b'1'), mk('b', head + b'1'), mk('c', head + b'2'), mk('d', b'zz')]
            sets = scanner.find_duplicates(rows, scanner.Ctl())
            self.assertEqual(len(sets), 1)
            self.assertEqual({os.path.basename(r['p']) for r in sets[0]}, {'a', 'b'})


class SafetyTest(unittest.TestCase):
    def test_refuses_outside_home(self):
        for bad in ('/etc/passwd', scanner.HOME, scanner.HOME + '/../other', '/'):
            with self.assertRaises(PermissionError):
                scanner.assert_inside_home(bad)
        self.assertEqual(scanner.assert_inside_home(scanner.HOME + '/a/b'), scanner.HOME + '/a/b')

    def test_clean_rejects_unknown_commands(self):
        with self.assertRaises(RuntimeError):
            scanner.clean_item({'kind': 'root', 'sysType': 'rm -rf /', 'group': 'system'})
        with self.assertRaises(RuntimeError):
            scanner.clean_item({'kind': 'docker', 'dockerType': 'x', 'group': 'docker'})

    def test_tree_dir_rejects_escape(self):
        for bad in ('..', '/etc', '../..'):
            with self.assertRaises(PermissionError):
                scanner.tree_dir(bad)

    def test_trash_only_for_large_and_dupe(self):
        calls = []
        with tempfile.TemporaryDirectory(dir=scanner.HOME) as d:
            for group, expect_trash in (('cache', False), ('large', True), ('dupe', True)):
                p = os.path.join(d, group)
                open(p, 'w').close()
                calls.clear()
                scanner.clean_item({'kind': 'file', 'group': group, 'paths': [p]}, trash=lambda x: calls.append(x))
                self.assertEqual(bool(calls), expect_trash, group)
                if not expect_trash:
                    self.assertFalse(os.path.exists(p))


class CsvTest(unittest.TestCase):
    def test_formula_injection_and_quotes(self):
        item = {'group': 'large', 'title': '=HYPERLINK("x")', 'paths': ['/a/b,"c"'], 'size': 1048576, 'level': 'review', 'note': '+cmd'}
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'o.csv')
            scanner.export_csv([item], p)
            with open(p, encoding='utf-8-sig') as f:
                raw = f.read()
        self.assertIn("\"'=HYPERLINK(\"\"x\"\")\"", raw)
        self.assertIn("\"'+cmd\"", raw)
        self.assertIn('"1.0"', raw)


if __name__ == '__main__':
    unittest.main()
