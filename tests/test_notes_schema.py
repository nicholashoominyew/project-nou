"""SQLite schema smoke tests, runnable with Python 3.11+ stdlib only."""
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db" / "notes" / "001_initial.sql"


def db():
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.executescript(MIGRATION.read_text(encoding="utf-8"))
    return connection


class NotesSchemaTest(unittest.TestCase):
    def setUp(self):
        self.conn = db()
        self.conn.execute("INSERT INTO workspaces(id,title) VALUES (?,?)", ("w1", "Personal"))

    def tearDown(self):
        self.conn.close()

    def add_page(self, page_id, key, parent=None):
        self.conn.execute(
            "INSERT INTO pages(id,workspace_id,parent_id,sort_key) VALUES (?,?,?,?)",
            (page_id, "w1", parent, key),
        )

    def test_migration_version(self):
        self.assertEqual(self.conn.execute("SELECT version FROM schema_migrations").fetchone(), (1,))

    def test_stable_manual_order(self):
        self.add_page("p3", "c")
        self.add_page("p1", "a")
        self.add_page("p2", "b")
        ids = [r[0] for r in self.conn.execute(
            "SELECT id FROM pages WHERE workspace_id=? AND parent_id IS NULL "
            "AND deleted_at IS NULL ORDER BY sort_key COLLATE BINARY,id", ("w1",)
        )]
        self.assertEqual(ids, ["p1", "p2", "p3"])

    def test_same_sibling_key_rejected(self):
        self.add_page("p1", "a")
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_page("p2", "a")

    def test_same_key_allowed_in_different_parents(self):
        self.add_page("folder1", "a")
        self.add_page("folder2", "b")
        self.add_page("p1", "a", "folder1")
        self.add_page("p2", "a", "folder2")

    def test_invalid_self_parent_rejected(self):
        self.add_page("p1", "a")
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute("UPDATE pages SET parent_id=id WHERE id='p1'")

    def test_soft_delete_frees_key_for_restore_policy(self):
        self.add_page("p1", "a")
        self.conn.execute("UPDATE pages SET deleted_at='2026-10-19' WHERE id='p1'")
        self.add_page("p2", "a")
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute("UPDATE pages SET deleted_at=NULL WHERE id='p1'")

    def test_yjs_update_order_and_invalid_bytes(self):
        self.add_page("p1", "a")
        self.conn.execute("INSERT INTO yjs_updates(page_id,seq,update_bytes) VALUES (?,?,?)",
                          ("p1", 1, b"update"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute("INSERT INTO yjs_updates(page_id,seq,update_bytes) VALUES (?,?,?)",
                              ("p1", 1, b"again"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute("INSERT INTO yjs_updates(page_id,seq,update_bytes) VALUES (?,?,?)",
                              ("p1", 2, b""))

    def test_search_index(self):
        self.add_page("p1", "a")
        self.conn.execute("INSERT INTO page_search(page_id,title,body) VALUES (?,?,?)",
                          ("p1", "Project NOU", "Offline knowledge notes"))
        results = self.conn.execute(
            "SELECT page_id FROM page_search WHERE page_search MATCH ?", ("knowledge",)
        ).fetchall()
        self.assertEqual(results, [("p1",)])

    def test_location_state_consistency(self):
        self.add_page("p1", "a")
        self.conn.execute("INSERT INTO note_locations(page_id) VALUES (?)", ("p1",))
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute(
                "UPDATE note_locations SET state='COPYING' WHERE page_id='p1'"
            )
        self.conn.execute(
            "UPDATE note_locations SET state='COPYING', destination_device='SERVER' WHERE page_id='p1'"
        )
        self.assertEqual(
            self.conn.execute("SELECT state FROM note_locations WHERE page_id='p1'").fetchone(),
            ("COPYING",),
        )


    def test_note_update_transactions_and_search_cache(self):
        self.add_page("note1", "a")
        # SQLite stores opaque Yjs update bytes; the JavaScript editor validates/decodes them.
        self.conn.execute("INSERT INTO yjs_updates(page_id,seq,update_bytes) VALUES (?,?,?)",
                          ("note1", 1, b"first-update"))
        self.conn.execute("INSERT INTO page_search(page_id,title,body) VALUES (?,?,?)",
                          ("note1", "Research", "Initial draft"))
        # Emulate append_note_update's atomic replacement of the FTS cache.
        with self.conn:
            sequence = self.conn.execute(
                "SELECT COALESCE(MAX(seq),0)+1 FROM yjs_updates WHERE page_id=?",
                ("note1",)).fetchone()[0]
            self.conn.execute("INSERT INTO yjs_updates(page_id,seq,update_bytes) VALUES (?,?,?)",
                              ("note1", sequence, b"second-update"))
            self.conn.execute("DELETE FROM page_search WHERE page_id=?", ("note1",))
            self.conn.execute("INSERT INTO page_search(page_id,title,body) VALUES (?,?,?)",
                              ("note1", "Research", "Updated offline notes"))
        self.assertEqual([row[0] for row in self.conn.execute(
            "SELECT update_bytes FROM yjs_updates WHERE page_id=? ORDER BY seq", ("note1",))],
            [b"first-update", b"second-update"])
        self.assertEqual(self.conn.execute(
            "SELECT page_id FROM page_search WHERE page_search MATCH 'offline'"
        ).fetchall(), [("note1",)])
        self.assertEqual(self.conn.execute(
            "SELECT page_id FROM page_search WHERE page_search MATCH 'Initial'"
        ).fetchall(), [])


if __name__ == "__main__":
    unittest.main()
