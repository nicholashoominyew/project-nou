"""SQLite behavioral regression tests for the Rust Trash/Restore transaction.

These exercise migration constraints and SQL semantics. Rust command integration
must also pass on Windows before considering the feature verified.
"""
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = (ROOT / "db" / "notes" / "001_initial.sql").read_text(encoding="utf-8")


class TrashRestoreTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        self.conn.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')")

    def tearDown(self):
        self.conn.close()

    def add_page(self, identity, parent, key, deleted=None):
        self.conn.execute(
            "INSERT INTO pages(id,workspace_id,parent_id,sort_key,deleted_at,title) "
            "VALUES(?,'personal',?,?,?,?)",
            (identity, parent, key, deleted, identity),
        )

    def restore(self, root, when):
        rows = self.conn.execute(
            """WITH RECURSIVE restored(id,parent_id) AS (
              SELECT id,parent_id FROM pages WHERE id=? AND deleted_at=?
              UNION ALL
              SELECT child.id,child.parent_id FROM pages child
              JOIN restored parent ON child.parent_id=parent.id
              WHERE child.deleted_at=? AND child.workspace_id='personal'
            ) SELECT id,parent_id FROM restored""", (root, when, when),
        ).fetchall()
        for page, _ in rows:
            self.conn.execute(
                "UPDATE pages SET sort_key=?,deleted_at=NULL WHERE id=? AND deleted_at=?",
                ("~restore-" + page, page, when),
            )
        parents = sorted({parent for _, parent in rows}, key=lambda p: p or "")
        for parent in parents:
            ordered = [r[0] for r in self.conn.execute(
                "SELECT id FROM pages WHERE workspace_id='personal' AND parent_id IS ? "
                "AND deleted_at IS NULL ORDER BY sort_key COLLATE BINARY,id", (parent,),
            )]
            for page in ordered:
                self.conn.execute("UPDATE pages SET sort_key=? WHERE id=?", ("~tmp-" + page, page))
            for index, page in enumerate(ordered):
                self.conn.execute(
                    "UPDATE pages SET sort_key=? WHERE id=?", (f"{(index + 1)*1024:016x}", page)
                )
        return rows

    def test_restore_after_sort_key_reuse_and_nested_pages(self):
        stamp = "2026-10-19T10:00:00.000Z"
        self.add_page("root", None, "a", stamp)
        self.add_page("child", "root", "a", stamp)
        self.add_page("existing", None, "a")
        restored = self.restore("root", stamp)
        self.assertEqual(set(p for p, _ in restored), {"root", "child"})
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL"
        ).fetchone()[0], 3)
        keys = self.conn.execute(
            "SELECT sort_key FROM pages WHERE parent_id IS NULL ORDER BY sort_key"
        ).fetchall()
        self.assertEqual(len(set(keys)), 2)

    def test_previous_independent_trash_is_not_restored(self):
        old = "2026-10-19T09:00:00.000Z"
        new = "2026-10-19T10:00:00.000Z"
        self.add_page("root", None, "a", new)
        self.add_page("prior-child", "root", "a", old)
        self.add_page("new-child", "root", "b", new)
        self.restore("root", new)
        self.assertEqual(self.conn.execute(
            "SELECT deleted_at FROM pages WHERE id='prior-child'"
        ).fetchone(), (old,))
        self.assertIsNone(self.conn.execute(
            "SELECT deleted_at FROM pages WHERE id='new-child'"
        ).fetchone()[0])


if __name__ == "__main__":
    unittest.main()
