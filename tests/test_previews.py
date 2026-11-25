import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import Editor


class PreviewTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = temporary.name
        sample = Path(directory) / "sample.pdf"
        with pymupdf.open() as document:
            document.new_page(width=400, height=600)
            document.new_page(width=600, height=400)
            document.save(sample)
        self.editor = Editor(directory)
        self.editor.open_local(sample)

    def test_reuses_preview_at_same_resolution(self):
        initial = self.editor.render_page(0, "full")
        with patch.object(self.editor, "document", side_effect=AssertionError("Unexpected render")):
            self.assertIs(self.editor.render_page(0, "1200"), initial)

    def test_invalidates_after_edit_and_history_actions(self):
        initial = self.editor.render_page(0, "thumb")
        self.editor.apply("rotate", {"pages": [0], "angle": 90})
        rotated = self.editor.render_page(0, "thumb")
        self.assertNotEqual(initial, rotated)
        self.editor.apply("undo", {})
        self.assertEqual(self.editor.render_page(0, "thumb"), initial)
        self.editor.apply("redo", {})
        self.assertEqual(self.editor.render_page(0, "thumb"), rotated)

    def test_evicts_old_entries_within_both_limits(self):
        maximum = max(len(self.editor.render_page(index, "thumb")) for index in (0, 1))
        self.editor.apply("rotate", {"pages": [1], "angle": 180})
        self.editor.render_page(0, "thumb")
        with patch("app.PREVIEW_CACHE_ENTRIES", 1), patch("app.PREVIEW_CACHE_BYTES", maximum):
            self.editor.render_page(1, "thumb")
            self.assertEqual(list(self.editor.previews), [(1, 120)])
            self.editor.render_page(0, "full")
            self.assertEqual(list(self.editor.previews), [(1, 120)])
            self.assertLessEqual(self.editor.preview_bytes, maximum)

    def test_print_preview_stays_outside_cache(self):
        screen = self.editor.render_page(0, "full")
        printed = self.editor.render_page(0, "print")
        self.assertNotEqual(screen, printed)
        self.assertEqual(self.editor.preview_bytes, len(screen))


if __name__ == "__main__":
    unittest.main()
