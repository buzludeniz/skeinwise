// Each migration runs once, in order. PRAGMA user_version records how many have run.
// Never edit a migration that has shipped in a release: add a new one.

export const MIGRATIONS: readonly string[] = [
  // 1. The record: sources, threads, entries and their versions. Originals are append-only.
  `
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    location TEXT,
    owner TEXT NOT NULL DEFAULT 'you',
    status TEXT NOT NULL DEFAULT 'in' CHECK (status IN ('in', 'out', 'later')),
    added_at TEXT NOT NULL,
    UNIQUE (kind, location)
  );

  CREATE TABLE threads (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    started_at TEXT NOT NULL,
    not_mine INTEGER NOT NULL DEFAULT 0,
    UNIQUE (source_id, external_id)
  );

  CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    thread_id INTEGER REFERENCES threads(id),
    external_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'note', 'file')),
    speaker TEXT NOT NULL,
    title TEXT,
    created_at TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE (source_id, external_id)
  );
  CREATE INDEX entries_thread ON entries (thread_id, seq);
  CREATE INDEX entries_created ON entries (created_at);

  CREATE TABLE versions (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries(id),
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    editor TEXT NOT NULL,
    edited_at TEXT NOT NULL,
    UNIQUE (entry_id, version)
  );
  CREATE INDEX versions_hash ON versions (content_hash);

  CREATE VIRTUAL TABLE entry_search USING fts5 (title, body, tokenize = 'porter unicode61');
  `,
];
