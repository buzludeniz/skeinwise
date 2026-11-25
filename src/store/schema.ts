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

  // 2. The organiser. Each pass of an engine is a run, and every row a run makes carries its run_id, so undoing the
  // run deletes exactly what it made. Nothing here changes entries or versions.
  `
  CREATE TABLE schemas (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    task TEXT NOT NULL CHECK (task IN ('tag', 'file', 'link', 'hub', 'layer', 'review', 'ask', 'correction')),
    engine TEXT NOT NULL CHECK (engine IN ('none', 'local', 'remote', 'you')),
    model TEXT,
    scope TEXT NOT NULL,
    schema_id INTEGER REFERENCES schemas(id),
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'undone')),
    counts TEXT NOT NULL DEFAULT '{}',
    message TEXT,
    -- Corrections: what undo puts back, and the objects they touch ({"targets": ["hub:3"], ...}).
    detail TEXT,
    -- The newest version id when the run started: scope "new" picks up versions after the last run's mark.
    mark INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX runs_task ON runs (task, status);

  -- run_id is NULL for a tag you defined, and set for a tag a run made (Topics, Projects).
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    schema_id INTEGER NOT NULL REFERENCES schemas(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    run_id INTEGER REFERENCES runs(id)
  );
  CREATE UNIQUE INDEX tags_defined ON tags (schema_id, name COLLATE NOCASE) WHERE run_id IS NULL;
  CREATE INDEX tags_run ON tags (run_id);

  CREATE TABLE entry_tags (
    entry_id INTEGER NOT NULL REFERENCES entries(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    run_id INTEGER NOT NULL REFERENCES runs(id),
    score REAL NOT NULL,
    PRIMARY KEY (entry_id, tag_id, run_id)
  );
  CREATE INDEX entry_tags_run ON entry_tags (run_id);
  CREATE INDEX entry_tags_tag ON entry_tags (tag_id);

  -- A merged folder points at the folder it was merged into; its name stays as an alias.
  CREATE TABLE folders (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    alias_of INTEGER REFERENCES folders(id),
    run_id INTEGER NOT NULL REFERENCES runs(id)
  );
  CREATE INDEX folders_run ON folders (run_id);

  CREATE TABLE entry_folders (
    entry_id INTEGER NOT NULL REFERENCES entries(id),
    folder_id INTEGER NOT NULL REFERENCES folders(id),
    run_id INTEGER NOT NULL REFERENCES runs(id),
    PRIMARY KEY (entry_id, folder_id, run_id)
  );
  CREATE INDEX entry_folders_run ON entry_folders (run_id);
  CREATE INDEX entry_folders_folder ON entry_folders (folder_id);

  -- Stored line kinds: cross (two entries about the same thing) and note (a [[link]] you wrote). Thread lines, hub
  -- spokes and time chains follow from threads, hub_entries and dates, so they are not stored.
  CREATE TABLE links (
    id INTEGER PRIMARY KEY,
    from_entry INTEGER NOT NULL REFERENCES entries(id),
    to_entry INTEGER NOT NULL REFERENCES entries(id),
    kind TEXT NOT NULL CHECK (kind IN ('cross', 'note')),
    score REAL NOT NULL,
    run_id INTEGER NOT NULL REFERENCES runs(id)
  );
  CREATE INDEX links_from ON links (from_entry);
  CREATE INDEX links_to ON links (to_entry);
  CREATE INDEX links_run ON links (run_id);

  -- sections: {"in_short": [...], "what_you_found": [...], "open_ends": [...]}, each item {text, entryId, date}.
  CREATE TABLE hubs (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'concept' CHECK (kind IN ('concept')),
    sections TEXT NOT NULL,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    deleted_by INTEGER REFERENCES runs(id)
  );
  CREATE INDEX hubs_run ON hubs (run_id);

  CREATE TABLE hub_entries (
    hub_id INTEGER NOT NULL REFERENCES hubs(id),
    entry_id INTEGER NOT NULL REFERENCES entries(id),
    run_id INTEGER NOT NULL REFERENCES runs(id),
    score REAL NOT NULL,
    PRIMARY KEY (hub_id, entry_id, run_id)
  );
  CREATE INDEX hub_entries_run ON hub_entries (run_id);
  CREATE INDEX hub_entries_entry ON hub_entries (entry_id);

  CREATE TABLE layers (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries(id),
    layer TEXT NOT NULL CHECK (layer IN ('cleaned', 'expanded', 'digest', 'ideas')),
    body TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    UNIQUE (entry_id, layer, run_id)
  );
  CREATE INDEX layers_run ON layers (run_id);

  -- reasons: [{entryId, date, quote, why}], the newer entries that suggest the note is out of date.
  CREATE TABLE review_items (
    id INTEGER PRIMARY KEY,
    note_entry INTEGER NOT NULL REFERENCES entries(id),
    reasons TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'updated', 'holds', 'skipped')),
    proposed TEXT NOT NULL,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    resolved_at TEXT
  );
  CREATE INDEX review_items_run ON review_items (run_id);
  CREATE INDEX review_items_note ON review_items (note_entry);

  -- What the organiser shows: done runs not replaced by a later done run of the same task (and schema). A run over
  -- everything replaces all earlier ones; a run over one source or date replaces earlier runs over the same; runs over
  -- new entries add to what is there.
  CREATE VIEW live_runs AS
    SELECT r.id, r.task, r.schema_id FROM runs r
    WHERE r.status = 'done' AND r.task NOT IN ('ask', 'correction') AND NOT EXISTS (
      SELECT 1 FROM runs later
      WHERE later.status = 'done' AND later.task = r.task AND later.id > r.id
        AND COALESCE(later.schema_id, 0) = COALESCE(r.schema_id, 0)
        AND (later.scope = 'all' OR (later.scope = r.scope AND later.scope <> 'new'))
    );

  INSERT INTO schemas (name, description, builtin) VALUES
    ('Topics', 'What entries are about, from clusters of related entries.', 1),
    ('Projects', 'Notes you link to from two or more other notes, and the entries that share their words.', 1),
    ('Moods', 'How you sound in your own words.', 1);
  INSERT INTO tags (schema_id, name, description)
    SELECT id, 'hopeful', 'hope hopeful excited glad looking forward finally works great' FROM schemas WHERE name = 'Moods'
    UNION ALL SELECT id, 'worried', 'worried worry anxious nervous afraid scared concerned stuck unsure' FROM schemas WHERE name = 'Moods'
    UNION ALL SELECT id, 'frustrated', 'frustrated annoying annoyed broken fails failing twice wrong again' FROM schemas WHERE name = 'Moods'
    UNION ALL SELECT id, 'curious', 'curious wonder wondering interesting question learn learning' FROM schemas WHERE name = 'Moods'
    UNION ALL SELECT id, 'proud', 'proud finished built shipped sold managed works' FROM schemas WHERE name = 'Moods'
    UNION ALL SELECT id, 'tired', 'tired exhausted busy overwhelmed late sleep' FROM schemas WHERE name = 'Moods';
  `,
];
