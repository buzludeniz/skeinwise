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
    -- A run over new entries writes a fresh copy of each hub they touch; the copy hides the hub it replaces.
    replaces INTEGER REFERENCES hubs(id),
    -- The correction run that deleted this hub; undoing that run brings it back.
    deleted_by INTEGER REFERENCES runs(id)
  );
  CREATE INDEX hubs_run ON hubs (run_id);
  CREATE INDEX hubs_replaces ON hubs (replaces);

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

  // 3. Runs an agent makes through the memory server: engine 'agent', the agent's name as the model. An agent's run
  // stays live until it is undone: a later organiser run never replaces it, and it never replaces one. SQLite can't
  // change a CHECK in place, so runs is rebuilt with the same ids (migrate turns foreign keys off around it).
  `
  DROP VIEW live_runs;

  CREATE TABLE runs_new (
    id INTEGER PRIMARY KEY,
    task TEXT NOT NULL CHECK (task IN ('tag', 'file', 'link', 'hub', 'layer', 'review', 'ask', 'correction')),
    engine TEXT NOT NULL CHECK (engine IN ('none', 'local', 'remote', 'you', 'agent')),
    model TEXT,
    scope TEXT NOT NULL,
    schema_id INTEGER REFERENCES schemas(id),
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'undone')),
    counts TEXT NOT NULL DEFAULT '{}',
    message TEXT,
    detail TEXT,
    mark INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  INSERT INTO runs_new (id, task, engine, model, scope, schema_id, status, counts, message, detail, mark, tokens_in,
                        tokens_out, started_at, finished_at)
    SELECT id, task, engine, model, scope, schema_id, status, counts, message, detail, mark, tokens_in, tokens_out,
           started_at, finished_at FROM runs;
  DROP TABLE runs;
  ALTER TABLE runs_new RENAME TO runs;
  CREATE INDEX runs_task ON runs (task, status);

  CREATE VIEW live_runs AS
    SELECT r.id, r.task, r.schema_id FROM runs r
    WHERE r.status = 'done' AND r.task NOT IN ('ask', 'correction') AND (r.engine = 'agent' OR NOT EXISTS (
      SELECT 1 FROM runs later
      WHERE later.status = 'done' AND later.task = r.task AND later.id > r.id AND later.engine <> 'agent'
        AND COALESCE(later.schema_id, 0) = COALESCE(r.schema_id, 0)
        AND (later.scope = 'all' OR (later.scope = r.scope AND later.scope <> 'new'))
    ));
  `,

  // 4. Live capture's state, one row per file it watches, so one bad file never moves another's cursor. Only
  // src/live reads and writes it; extra is JSON that live alone interprets (fingerprints, a session's cursor).
  `
  CREATE TABLE live_files (
    path TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    size INTEGER,
    mtime_ms REAL,
    sha256 TEXT,
    byte_offset INTEGER NOT NULL DEFAULT 0,
    last_ok_at TEXT,
    saved_at TEXT,
    last_error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_try_at TEXT,
    extra TEXT
  );
  CREATE INDEX live_files_target ON live_files (target);
  `,

  // 5. Provenance, and imports that propose instead of overwrite.
  // - Every version says when Skeinwise saw it (observed_at), what time the file claimed (claimed_at), which file it
  //   came from (origin path and SHA-256), which account the export claimed, and the run that made it. versions is
  //   rebuilt (same ids) so observed_at can be NOT NULL; old rows get the best time known.
  // - A thread's title is versioned in thread_titles instead of being overwritten; threads.title is the current one.
  // - entries.claimed_at keeps the time the file claimed; time_flag marks one that is missing, more than a day after it
  //   was seen, or before 1990, and created_at (what everything sorts by) becomes observed_at for those.
  //   project and git_branch come from agent sessions.
  // - sources.account is the account fingerprint the source's first import claimed.
  // - pending holds a batch that would change the record but isn't trusted (a capture, or another account's export)
  //   until the person accepts or rejects it. One row per origin file and source kind, in any state, so a rejected
  //   file never comes back; the batch itself is dropped once decided.
  `
  CREATE TABLE versions_new (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries(id),
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    editor TEXT NOT NULL,
    edited_at TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    claimed_at TEXT,
    title TEXT,
    properties TEXT,
    origin_path TEXT,
    origin_sha256 TEXT,
    account TEXT,
    run_id INTEGER REFERENCES runs(id),
    UNIQUE (entry_id, version)
  );
  INSERT INTO versions_new (id, entry_id, version, body, content_hash, editor, edited_at, observed_at, claimed_at)
    SELECT v.id, v.entry_id, v.version, v.body, v.content_hash, v.editor, v.edited_at,
           CASE WHEN v.version = 1
             THEN COALESCE((SELECT s.added_at FROM entries e JOIN sources s ON s.id = e.source_id WHERE e.id = v.entry_id), v.edited_at)
             ELSE v.edited_at END,
           CASE WHEN v.version = 1 THEN v.edited_at END
    FROM versions v;
  DROP TABLE versions;
  ALTER TABLE versions_new RENAME TO versions;
  CREATE INDEX versions_hash ON versions (content_hash);
  CREATE INDEX versions_run ON versions (run_id) WHERE run_id IS NOT NULL;

  CREATE TABLE thread_titles (
    id INTEGER PRIMARY KEY,
    thread_id INTEGER NOT NULL REFERENCES threads(id),
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    editor TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    origin_path TEXT,
    origin_sha256 TEXT,
    account TEXT,
    run_id INTEGER REFERENCES runs(id),
    UNIQUE (thread_id, version)
  );
  INSERT INTO thread_titles (thread_id, version, title, editor, observed_at)
    SELECT t.id, 1, t.title, 'import', s.added_at FROM threads t JOIN sources s ON s.id = t.source_id;

  ALTER TABLE entries ADD COLUMN observed_at TEXT;
  ALTER TABLE entries ADD COLUMN claimed_at TEXT;
  ALTER TABLE entries ADD COLUMN time_flag TEXT CHECK (time_flag IN ('missing', 'future', 'early'));
  ALTER TABLE entries ADD COLUMN project TEXT;
  ALTER TABLE entries ADD COLUMN git_branch TEXT;
  UPDATE entries SET observed_at = (SELECT s.added_at FROM sources s WHERE s.id = entries.source_id), claimed_at = created_at;
  -- Version 0.3 wrote the epoch for a missing time.
  UPDATE entries SET time_flag = 'missing', claimed_at = NULL WHERE created_at LIKE '1970-01-01T00:00:00%';
  UPDATE versions SET claimed_at = NULL WHERE version = 1 AND claimed_at LIKE '1970-01-01T00:00:00%';
  UPDATE entries SET time_flag = 'early' WHERE time_flag IS NULL AND created_at < '1990-01-01';
  UPDATE entries SET time_flag = 'future' WHERE time_flag IS NULL AND julianday(created_at) > julianday(observed_at) + 1;
  UPDATE entries SET created_at = observed_at WHERE time_flag IS NOT NULL AND observed_at IS NOT NULL;
  CREATE INDEX entries_project ON entries (project) WHERE project IS NOT NULL;

  ALTER TABLE sources ADD COLUMN account TEXT;

  CREATE TABLE pending (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    reason TEXT NOT NULL CHECK (reason IN ('unconfirmed', 'account')),
    source_kind TEXT NOT NULL,
    source_label TEXT NOT NULL,
    origin_path TEXT,
    origin_sha256 TEXT,
    account TEXT,
    threads INTEGER NOT NULL DEFAULT 0,
    entries INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    batch TEXT,
    observed_at TEXT NOT NULL,
    decided_at TEXT,
    CHECK ((status = 'pending') = (batch IS NOT NULL))
  );
  CREATE UNIQUE INDEX pending_origin ON pending (origin_sha256, source_kind) WHERE origin_sha256 IS NOT NULL;
  CREATE INDEX pending_status ON pending (status);
  `,
];
