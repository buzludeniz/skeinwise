<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo-mark-dark.svg">
  <img src="brand/logo-mark.svg" alt="" width="40" height="40">
</picture>

# Skeinwise: features

This is the whole design. Parts not built yet are marked *(planned)* with the release that brings them; the
README's roadmap has the order, and [organiser.md](organiser.md) says exactly what the organiser does today.

## The record

The record is one SQLite file, `~/.skeinwise/record.db`, plus Markdown notes in `~/.skeinwise/notes`.

- **Tables:** sources, threads, entries and versions.
- **Entry:** one message, note or file, with a kind, a speaker (you, an assistant or a named person), a thread, a
  source, a created date and a content hash.
- **Originals are append-only.** An edit adds a version with its editor and date; nothing is overwritten.
- **"Not mine":** a conversation marked this way leaves the brain, search and notes, but stays in history.
- **Provenance:** each version records where it came from (the file and its SHA-256) and which account.
- **Pending:** a capture you didn't start, or an export from another account than the source's, waits in pending
  until you say yes.

## Importers

| Source | Reads |
|---|---|
| ChatGPT export | `conversations.json`, following the active branch of each conversation |
| Claude export | `conversations.json` |
| Gemini (Google Takeout) | `MyActivity.json`; prompts are grouped into threads by 30-minute gaps |
| Claude Code history | `~/.claude/projects/*/*.jsonl`; text only, tool calls dropped |
| Codex history | `~/.codex/sessions/**/*.jsonl` |
| Markdown folders and Obsidian vaults | Front matter, `[[links]]` and `#tags`; the date comes from front matter, the file name or the modified time |
| Plain text | `.txt` files as notes |

Each importer accepts a zip file, a single file or a folder. Unknown fields are skipped, and missing fields don't stop
an import.

- **One bad value** skips or flags only its entry, named by file and place.
- **Symbolic links, FIFOs and devices** are skipped and named.
- **A zip is refused** past 20,000 files, 4 GiB unpacked, or 200 times its packed size.
- **A file over 1 GiB** is refused.
- **A time** more than a day ahead, before 1990 or missing is flagged, and the entry is sorted by when it was seen.

## Connectors

- Read-only Gmail, Google Calendar, Todoist and Slack.
- Each has its own consent, which shows the permissions it asks for before any sign-in.
- Each uses your own OAuth client or Slack app, so no one else's server sits between you and the service.
- Tokens live in the macOS Keychain, never in a file.
- `skeinwise live` pulls what changed from each connection every 5 minutes.
- An item deleted at the service is kept in the record.

Details: [connectors.md](connectors.md).

## Dedupe and versions

- Each entry is keyed by its source and its external id, so re-importing the same export adds nothing.
- A changed text becomes a new version, and the newest version counts.
- Re-importing an older export doesn't roll an entry back: text the entry already held in any version is ignored.
- `skeinwise restore <entry> <version>` brings an old version back as a new one, so the versions in between are kept.

## Search

- Full-text search with stemming over titles and bodies (SQLite FTS5), ranked by relevance, with your own words ranked
  above an assistant's.
- Filters: source, speaker and date range. Folder and tag filters are *(planned, v0.4)*.
- **Similar entries:** by term vectors (TF-IDF cosine): entries that share rare words rank closest.
- Results can be lit up as points in the brain *(planned, v0.4)*.

## Ask

A question in plain words becomes a view. Search and a few rules gather the entries that answer it. Three patterns
list them in date order: "when did I first …", "what did I decide about …" and "what changed in my thinking on …".
Any other question lists the best matches with your own words first.

- **With the local model (the default) or an outside model,** a short answer sits on top and cites the entry ids it
  rests on. Ids that aren't among the candidates are refused, so an answer can't cite an entry that doesn't exist.
- **With No AI,** the view is built from search and dates alone.

## The organiser and runs

| Task | What it makes |
|---|---|
| tag | Tags on entries |
| file | Entries filed into folders |
| link | Cross links between entries |
| hub | Concept hubs: In short, What you found, Open ends |
| layer | Cleaned, Expanded, Digest and Ideas layers for an entry |
| review | Notes that may be out of date |

- **Each pass is a run,** with its task, engine, model, scope, status, counts, token use, and start and end times.
- Everything a run makes records the run's id, and **Undo run** deletes all of it.
- **Scope:** everything, a source, a date range, a folder *(planned)*, or `new` (entries added since that task's last successful
  run, which is what background organising uses).
- `--preview` shows every request a run would send, without sending it. A model run over more than 500 entries
  stops at its size estimate until you add `--yes`.

## Engines

Skeinwise has its own built-in AI: a small model that runs on your computer. It is the default, and it does the work
that needs judgement: hub summaries, folder proposals and names, the staleness review with its reasons and proposed
updates, answers to questions, and the derived layers. Tagging leans on statistics first and asks the model only
about entries that match a tag by one word. Linking and similarity are statistics only.

| Engine | Setting | What runs |
|---|---|---|
| **Local model** (default) | `local` | An OpenAI-compatible server on this computer: llama.cpp's `llama-server` or Ollama, at `http://127.0.0.1:8731/v1` unless you change it. Nothing leaves the computer |
| **Outside model** | `remote` | Any OpenAI-compatible endpoint, with the key read from an environment variable you name. Redaction and the usage cap apply |
| **No AI** | `none` | Keyword statistics (TF-IDF), k-means clustering of term vectors for hubs and folders, similarity for links, and extractive summaries |

- Every task runs with every engine; only the Expanded layer needs a model. A model's output is asked for as JSON and checked before anything is saved.
- **No silent fallback.** If the local model isn't running, a task stops and says how to start it, and that
  `--engine none` works without one. It never switches engines on its own.
- **Thinking off.** Small reasoning models answer with their thinking switched off, which keeps background passes
  fast.

## The local model

The server address and model are set with `skeinwise config`; the `model` commands check, fetch and start the
suggested one.

- **Suggested model:** Qwen3-4B, quantised to Q4_K_M (about 2.5 GB), in GGUF form. Any instruction-tuned model that
  the server can run works; smaller ones are faster and rougher.
- **Pointing at one you have:** set the address in Settings or `config.json`. `skeinwise model check` asks the server
  for its models and runs one short test prompt, and says how long it took.
- **Fetching one:** `skeinwise model fetch` downloads the suggested model into `~/.skeinwise/models/`, after showing
  the size and the source and asking first. It keeps the file only when its sha256 matches the one the source lists,
  and a cut-off download picks up where it stopped. `skeinwise model serve` prints the `llama-server` command for it
  (`--run` runs it).
- **Weights never go in the repository,** and nothing is downloaded without that command.

## The update stream

The record keeps itself current without you running anything.

1. **Live capture.** With **Record live** on (`skeinwise live` on the command line), Skeinwise watches Claude Code
   and Codex history and the note folders and vaults you chose (`liveFolders`). New and changed entries are imported
   within seconds, through the same importers as a manual import, so dedupe and versions work the same way. On
   start-up it catches up on whatever changed while it was off. Downloads is watched only when you ask (below).
2. **Background organising.** After each capture, the organiser runs over the new entries only (`--scope new`:
   entries added or changed since that task's last run): tag, file, link, then the summaries of the hubs those entries
   joined, then a staleness check of the notes on those hubs. One pass runs at a time; captures that arrive during a
   pass get one more pass after it. It waits while the computer is busy (load above 85% of its cores) or the battery
   is below 20% and discharging, and tries again a minute later.
3. **Status.** Two lines say what happened last: "saved 2 minutes ago", "caught up 3 chats from Claude Code ·
   organised 41 new entries". Every background pass is an ordinary run, listed in Runs and undoable.

- **The first pass is yours.** A task that has never run over the whole record is left alone, and the status line
  says `not organised yet: run "skeinwise run all" once to start`. After that first run, the background keeps it
  current.
- **Layers stay manual.** The layer task asks the model once per entry, so it only runs when you run it.
- **Engines.** With the local model, background organising needs no approval. With an outside model it runs only if
  you allow it (`liveRemote`, off by default) and always within the monthly budget. With No AI it uses the No-AI
  engine. If the model server doesn't answer, the status line says so and the next capture tries again.
- **Stopping.** Closing live mid-run marks that run failed and saves nothing from it, so the next run isn't blocked.
- **Off switch.** `skeinwise config liveOrganise off` keeps live capture and leaves organising to you.
- **Connectors.** Live also pulls from the services you connected, and what a pull brings is organised like a
  capture.
- **Downloads** is off by default; `skeinwise config liveDownloads on` turns it on. Then a ChatGPT, Claude or Gemini
  export that lands there is proposed, never imported: review it with `skeinwise live pending` (`--all` for the ones
  already decided), then `skeinwise live accept <n>` or `skeinwise live reject <n>`. The same file is never proposed
  twice, and a rejected one is never proposed again. Accepting keeps the version each change replaced. Only chat
  exports are proposed, a link is refused, and the status line counts what waits.
- **One bad file never stops live.** It is listed by its path and tried again after 1 min, 5 min and 30 min, then
  hourly, and at once when it changes. A bad line is skipped, or kept with no time, and named by `file:line`.
- **A busy record** (another skeinwise command writing to it) makes live wait and try again.
- **A corrupt `live.json`** is moved aside to `live.json.bad-<time>`, and live starts afresh.
- **Large sessions.** A growing Claude Code session is read from where the last read stopped. The first pass after
  an upgrade reads every watched file whole once.

## Tagging schemas

A schema is a named list of tags with descriptions. Topics, Projects and Moods are built in, and you can add your own.

- **Before a run** *(planned)*: a sample test on 20 entries, then the full size and cost estimate.
- **After a run:** coverage (the share of entries tagged). A comparison with an earlier run of the same schema (tags
  added, removed and unchanged) is *(planned)*.

## Corrections

- **Edit an entry** *(planned, v0.4)*. The original stays in history.
- **Merge folders.** The old name stays as an alias; one step undoes it.
- **Rename or delete a hub.**
- **Mark a thread "not mine".**
- **Exclude a source.** Its entries leave the brain and search; you can include it again later.

Undo covers runs, folder merges and hub changes today. Undoing an exclusion, a "not mine", a review answer or a
schema edit is *(planned)*; until then each has its own reverse command, such as `include`.

## Notes

- Notes are Markdown files under `~/.skeinwise/notes`, edited in the app or in any editor.
- `[[links]]` become note links.
- There is one daily note per day.
- A note written by an agent is marked with the agent's name *(planned, v0.5)*.
- Each save adds a version.

## Review

The organiser compares each note with your newer entries in the same hubs. With a model, it reads them and says
whether the note is out of date, why, and how it would read updated. With No AI, it flags a note when a newer entry
close to it says something like "decided", "no longer" or "switch to", which also catches decisions that don't
overturn the note. Flagged notes go into the Review queue with the reasons. You choose: update (shown as a diff first),
still holds, or skip. A skipped note comes back after the next review run.

## Privacy

- With the local model or No AI, nothing leaves the computer.
- **Redaction:** before any text goes to an outside model, the names you list, emails, phone numbers, street
  addresses and health words are replaced with placeholders. The patterns catch the common shapes, not every one.
  `--preview` shows exactly what will be sent.
- **Usage cap:** a monthly token cap for an outside model. A run that would pass it is refused until the month
  resets.
- **The record folder** is created with owner-only permissions.
- Connectors only read, and their tokens live in the macOS Keychain, never in a file.
- **The app's server** *(planned, v0.4)* listens on 127.0.0.1 only and needs a per-install token.

## Agent memory (MCP)

A local MCP server over stdio gives an AI agent your record as its memory. `skeinwise connect <agent>` sets it up for
Claude Code, Claude desktop, Codex or Cursor, and `skeinwise doctor` checks the setup.

- **Read tools**, for every allowed agent: `search`, `ask`, `read_entry`, `read_thread`, `timeline`, `list_hubs`,
  `read_hub`.
- **Write tools**, only for an agent allowed with `--write`: `write_note`, `append_daily_note`, `tag_entries`,
  `not_mine`, `undo_run`. `not_mine` and `undo_run` change nothing until you confirm them (`skeinwise mcp pending`,
  `confirm`, `refuse`).
- An agent is known by a token that `skeinwise mcp allow <agent>` shows once; the record keeps only its hash. Read is
  the default scope. `skeinwise mcp lock` stops every agent tool at once.
- Results are framed as untrusted data, with secrets replaced by placeholders, and cut to 20 entries and 32 KB a call
  and 500 KB a session.
- Every call is logged (`skeinwise mcp log`): the agent, the tool, the entries it was sent and how much.
- Every agent write is a version under the agent's name. An agent never changes your notes or another agent's.

Details: [mcp.md](mcp.md).

## Ledger and proof of date *(planned, v0.5)*

- Every import, edit and run appends a line to `ledger.jsonl`, with a hash chained to the line before. Any later
  change to the ledger breaks the chain and shows.
- Optionally, the latest ledger hash is stamped with OpenTimestamps to prove the record existed at that date. The
  proof is collected a few hours later and stored next to the ledger.

## Command line

| Command | Does |
|---|---|
| `skeinwise init` | Creates the record folder |
| `skeinwise import <path>…` | Imports exports, history folders or note folders |
| `skeinwise search <words>` | Full-text search |
| `skeinwise history <entry>`, `skeinwise restore <entry> <version>` | Lists an entry's versions; brings an old one back as a new version |
| `skeinwise ask <question>` | A question, answered as a view |
| `skeinwise run <task> [--scope new]` | Runs an organiser task |
| `skeinwise runs`, `skeinwise undo <run>` | Lists runs; undoes one |
| `skeinwise note <text>` | Appends to today's daily note |
| `skeinwise live [--once]` | Turns on the update stream: live capture and background organising, and pulls from connected services |
| `skeinwise live pending [--all]`, `accept <n>`, `reject <n>` | Imports waiting for your yes (Downloads, another account's export); takes one in or leaves it out for good |
| `skeinwise model check`, `fetch`, `serve` | Tests, downloads (after asking) or starts the local model |
| `skeinwise serve` | Starts the app *(planned, v0.4)* |
| `skeinwise setup [--yes]` | Finds your AI histories and notes, brings them in, and names the agents to connect |
| `skeinwise connect <agent> [--write] [--yes]` | Gives claude-code, codex, cursor or claude-desktop your record as memory; read only unless `--write` |
| `skeinwise doctor` | Checks Node, the record, live capture, the model server and agent configs, with one fix per problem |
| `skeinwise mcp` | Starts the memory server for an agent over stdio |
| `skeinwise mcp allow`, `deny`, `agents`, `lock`, `unlock`, `log`, `pending`, `confirm`, `refuse` | Which agents may use the record, what they asked for, and the lock that stops them all |
| `skeinwise demo` | Builds a demo record from invented data |
| `skeinwise export` | Writes a zip of the record: chats, entries and notes as Markdown; tags, folders, hubs and runs as JSON |

