"""Cross-platform regression tests for SQLite's WAL-safe VACUUM INTO snapshot mechanism.

Uses Python stdlib only. Rust's backup.rs tests separately cover app-layer backup validation.
"""
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import closing

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = (ROOT / "db" / "notes" / "001_initial.sql").read_text(encoding="utf-8")


class SnapshotSafetyTests(unittest.TestCase):
    def test_snapshot_captures_committed_wal_without_later_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            live = Path(directory) / "live.sqlite3"
            snapshot = Path(directory) / "snapshot.sqlite3"
            connection = sqlite3.connect(live)
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript(SCHEMA)
            connection.execute("INSERT INTO workspaces(id,title) VALUES('w1','Personal')")
            connection.execute(
                "INSERT INTO pages(id,workspace_id,sort_key,title) VALUES(?,?,?,?)",
                ("p1", "w1", "a", "Before snapshot"),
            )
            connection.commit()
            connection.execute("VACUUM INTO ?", (str(snapshot),))
            connection.execute("UPDATE pages SET title='After snapshot' WHERE id='p1'")
            connection.commit()
            # sqlite3.Connection.__exit__ commits/rolls back; it does NOT close the handle.
            # Explicit closing prevents WinError 32 when TemporaryDirectory cleans up.
            with closing(sqlite3.connect(snapshot)) as restored:
                self.assertEqual(restored.execute("PRAGMA integrity_check").fetchone(), ("ok",))
                self.assertEqual(restored.execute(
                    "SELECT title FROM pages WHERE id='p1'"
                ).fetchone(), ("Before snapshot",))
                self.assertEqual(restored.execute(
                    "SELECT MAX(version) FROM schema_migrations"
                ).fetchone(), (1,))
            connection.close()

    def test_refuses_overwriting_existing_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            live = Path(directory) / "live.sqlite3"
            snapshot = Path(directory) / "snapshot.sqlite3"
            connection = sqlite3.connect(live)
            connection.executescript(SCHEMA)
            connection.execute("VACUUM INTO ?", (str(snapshot),))
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("VACUUM INTO ?", (str(snapshot),))
            self.assertTrue(snapshot.is_file())
            connection.close()


if __name__ == "__main__":
    unittest.main()
