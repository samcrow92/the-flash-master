"""SQLite access: one shared connection guarded by a re-entrant lock, numbered migrations (append only)."""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

from .util import now_iso

# Append new migrations at the end; never edit an old one.
MIGRATIONS: list[str] = [
    """
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('user','admin')),
      token_hash TEXT UNIQUE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE plugins (
      id TEXT PRIMARY KEY,
      owner_id INTEGER,
      owner_name TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE plugin_versions (
      plugin_id TEXT NOT NULL,
      version TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      team TEXT NOT NULL DEFAULT '',
      kinds TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      sha256 TEXT NOT NULL,
      author TEXT,
      submission_id INTEGER,
      published_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, version)
    );
    CREATE TABLE submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id TEXT NOT NULL,
      version TEXT NOT NULL,
      name TEXT NOT NULL,
      kinds TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      feedback TEXT,
      author_id INTEGER,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewer TEXT
    );
    CREATE INDEX submissions_author ON submissions(author_id);
    CREATE INDEX submissions_status ON submissions(status);
    CREATE TABLE releases (
      version TEXT PRIMARY KEY,
      channel TEXT,
      date TEXT,
      notes TEXT NOT NULL DEFAULT '',
      published INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE release_files (
      version TEXT NOT NULL,
      name TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploaded_at TEXT NOT NULL,
      PRIMARY KEY (version, name)
    );
    CREATE TABLE channels (
      name TEXT PRIMARY KEY CHECK (name IN ('stable','beta')),
      version TEXT
    );
    """,
]


class DB:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self._depth = 0
        self.conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None, timeout=30)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=30000")
        self.migrate()

    def migrate(self) -> int:
        with self.tx():
            self.conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
            done = {r[0] for r in self.conn.execute("SELECT version FROM schema_migrations")}
            for n, sql in enumerate(MIGRATIONS, start=1):
                if n in done:
                    continue
                for stmt in (s.strip() for s in sql.split(";")):
                    if stmt:
                        self.conn.execute(stmt)
                self.conn.execute("INSERT INTO schema_migrations VALUES (?, ?)", (n, now_iso()))
        return len(MIGRATIONS)

    @contextmanager
    def tx(self):
        """Serialised transaction; nested calls join the outer one."""
        with self.lock:
            outer = self._depth == 0
            if outer:
                self.conn.execute("BEGIN IMMEDIATE")
            self._depth += 1
            try:
                yield self.conn
            except BaseException:
                self._depth -= 1
                if outer:
                    self.conn.execute("ROLLBACK")
                raise
            self._depth -= 1
            if outer:
                self.conn.execute("COMMIT")

    def all(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, args).fetchall()

    def one(self, sql: str, args: tuple = ()):
        with self.lock:
            return self.conn.execute(sql, args).fetchone()

    def run(self, sql: str, args: tuple = ()) -> sqlite3.Cursor:
        with self.lock:
            return self.conn.execute(sql, args)

    def backup_to(self, dest: Path) -> None:
        with self.lock:
            out = sqlite3.connect(str(dest))
            try:
                self.conn.backup(out)
            finally:
                out.close()

    def close(self) -> None:
        with self.lock:
            self.conn.close()
