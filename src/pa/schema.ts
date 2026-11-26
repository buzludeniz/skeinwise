// The assistant's tables, added by one migration at the end of MIGRATIONS (src/store/schema.ts). Nothing here changes
// entries or versions: the assistant reads the record and keeps only its own lists beside it.

export const PA_MIGRATION = `
  -- Your tasks. A task with remind_at is also a reminder; reminded_at says when the app last showed it as due.
  -- loop_key and entry_id say which open loop and entry a task came from, when it came from one.
  CREATE TABLE pa_tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
    due_day TEXT,
    remind_at TEXT,
    reminded_at TEXT,
    entry_id INTEGER REFERENCES entries(id),
    loop_key TEXT,
    made_by TEXT NOT NULL DEFAULT 'you' CHECK (made_by IN ('you', 'none', 'local', 'remote')),
    run_id INTEGER REFERENCES runs(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    done_at TEXT
  );
  CREATE INDEX pa_tasks_status ON pa_tasks (status, due_day);
  CREATE INDEX pa_tasks_remind ON pa_tasks (status, remind_at);
  CREATE UNIQUE INDEX pa_tasks_loop ON pa_tasks (loop_key) WHERE loop_key IS NOT NULL;

  -- What you said about an open loop the assistant found: done, dropped, or snoozed until a day.
  CREATE TABLE pa_loops (
    key TEXT PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries(id),
    status TEXT NOT NULL CHECK (status IN ('done', 'dropped', 'snoozed')),
    until_day TEXT,
    updated_at TEXT NOT NULL
  );

  -- A model's reading of the sentences it was shown, kept with the run that read them: whether each is an open loop,
  -- and if so what it asks, of whom and by when.
  CREATE TABLE pa_found (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    key TEXT NOT NULL,
    entry_id INTEGER NOT NULL REFERENCES entries(id),
    is_loop INTEGER NOT NULL CHECK (is_loop IN (0, 1)),
    kind TEXT CHECK (kind IN ('promise', 'todo', 'waiting', 'reminder')),
    what TEXT,
    who TEXT,
    due_day TEXT,
    UNIQUE (run_id, key)
  );
  CREATE INDEX pa_found_key ON pa_found (key, run_id);

  -- The briefs: each covers the versions after from_mark up to to_mark (versions.id), so the next starts where the
  -- last ended. body is the brief as JSON.
  CREATE TABLE pa_briefs (
    id INTEGER PRIMARY KEY,
    day TEXT NOT NULL,
    from_mark INTEGER NOT NULL,
    to_mark INTEGER NOT NULL,
    engine TEXT NOT NULL CHECK (engine IN ('none', 'local', 'remote')),
    model TEXT,
    run_id INTEGER REFERENCES runs(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX pa_briefs_day ON pa_briefs (day, id);
`;
