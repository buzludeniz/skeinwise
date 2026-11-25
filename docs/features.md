# Skeinwise: features

## The record

The record is one SQLite file, `~/.skeinwise/record.db`, plus Markdown notes in `~/.skeinwise/notes`.

- **Tables:** sources, threads, entries and versions.
- **Entry:** one message, note or file, with a kind, a speaker (you, an assistant or a named person), a thread, a
  source, a created date and a content hash.
- **Originals are append-only.** An edit adds a version with its editor and date; nothing is overwritten.
- **"Not mine":** a conversation marked this way leaves the brain, search and notes, but stays in history.

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

## Dedupe and versions

- Each entry is keyed by its source and its external id, so re-importing the same export adds nothing.
- A changed text becomes a new version, and the newest version counts.
- Re-importing an older export doesn't roll an entry back: text the entry already held in any version is ignored.

## Search

- Full-text search with stemming over titles and bodies (SQLite FTS5), ranked by relevance, with your own words ranked
  above an assistant's.
- Filters: source, speaker, date range, folder and tag.
- **Similar entries:** by term vectors (TF-IDF cosine), so related entries turn up even without shared words.
- Results can be lit up as points in the brain.

## Ask

A question in plain words becomes a view. Search gathers the candidate entries, the engine picks the ones that answer
the question, and they are listed by date with your own quotes first. Patterns include "when did I first …", "what
did I decide about …" and "what changed in my thinking on …".

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
- **Scope:** everything, a source, a folder, a date range, or `new` (entries added since that task's last successful
  run, which is what background organising uses).
- A run over a large scope shows a size estimate first and waits for approval.

## Engines

Skeinwise has its own built-in AI: a small model that runs on your computer. It is the default, and it does the work
that needs judgement: hub summaries, folder proposals and names, the staleness review with its reasons and proposed
updates, answers to questions, and the derived layers. Tagging, linking and similarity lean on statistics first and
ask the model only where the statistics are unsure.

| Engine | Setting | What runs |
|---|---|---|
| **Local model** (default) | `local` | An OpenAI-compatible server on this computer: llama.cpp's `llama-server` or Ollama, at `http://127.0.0.1:8731/v1` unless you change it. Nothing leaves the computer |
| **Outside model** | `remote` | Any OpenAI-compatible endpoint, with the key read from an environment variable you name. Redaction and the usage cap apply |
| **No AI** | `none` | Keyword statistics (TF-IDF), k-means clustering of term vectors for hubs and folders, similarity for links, and extractive summaries |

- Every task works with every engine. A model's output is asked for as JSON and checked before anything is saved.
- **No silent fallback.** If the local model isn't running, a task stops and says how to start it, and that
  `--engine none` works without one. It never switches engines on its own.
- **Thinking off.** Small reasoning models answer with their thinking switched off, which keeps background passes
  fast.

## The local model

- **Suggested model:** Qwen3-4B, quantised to Q4_K_M (about 2.5 GB), in GGUF form. Any instruction-tuned model that
  the server can run works; smaller ones are faster and rougher.
- **Pointing at one you have:** set the address in Settings or `config.json`. `skeinwise model check` asks the server
  for its models and runs one short test prompt.
- **Fetching one:** `skeinwise model fetch` downloads the suggested model into `~/.skeinwise/models/`, after showing
  the size and the source and asking first. `skeinwise model serve` prints (or runs) the `llama-server` command for it.
- **Weights never go in the repository,** and nothing is downloaded without that command.

## The update stream

The record keeps itself current without you running anything.

1. **Live capture.** With **Record live** on, Skeinwise watches Claude Code and Codex history, the note folders and
   vaults you chose, and Downloads for new ChatGPT, Claude and Gemini exports. New and changed entries are imported
   within seconds, through the same importers as a manual import, so dedupe and versions work the same way.
2. **Background organising.** After each capture, a queue runs the organiser over the new entries only (`--scope
   new`: entries added since that task's last successful run): tag, file, link, then the summaries of the hubs those
   entries touched, then a staleness check of the notes on those hubs. It works in small batches at low priority and
   pauses while you use the computer heavily or the battery is low.
3. **Status.** The app menu's two lines say what happened last: "saved 2 minutes ago", "caught up 3 chats from Claude
   Code · organised 41 new entries". Every background pass is an ordinary run, listed in Runs and undoable.

With the local model, background organising needs no approval. With an outside model it runs only within the usage
cap and only if you allow background runs in Settings. With No AI it uses the No-AI engine.

## Tagging schemas

A schema is a named list of tags with descriptions. Topics, Projects and Moods are built in, and you can add your own.

- **Before a run:** a sample test on 20 entries, then the full size and cost estimate.
- **After a run:** coverage (the share of entries tagged), and a comparison with an earlier run of the same schema:
  tags added, removed and unchanged.

## Corrections

- **Edit an entry.** The original stays in history.
- **Merge folders.** The old name stays as an alias; one step undoes it.
- **Rename or delete a hub.**
- **Mark a thread "not mine".**
- **Exclude a source.** Its entries leave the brain and search; you can include it again later.

Every correction can itself be undone.

## Notes

- Notes are Markdown files under `~/.skeinwise/notes`, edited in the app or in any editor.
- `[[links]]` become note links.
- There is one daily note per day.
- A note written by an agent is marked with the agent's name.
- Each save adds a version.

## Review

The organiser compares each note with newer entries on the same topic. When the newer entries disagree with the note
or add a lot to it, the note goes into the Review queue with the reasons. You choose: update (shown as a diff first),
still holds, or skip. A skipped note comes back after the next review run.

## Privacy

- With the local model or No AI, nothing leaves the computer.
- **Redaction:** before any text goes to an outside model, names, emails, phone numbers, street addresses and health
  terms are replaced with placeholders. A preview shows exactly what will be sent.
- **Usage cap:** a monthly token cap for an outside model pauses runs until the month resets.
- **The record folder** is created with owner-only permissions.
- **The server** listens on 127.0.0.1 only and needs a per-install token.

## Agent memory (MCP)

Two local MCP servers over stdio, so an agent can be given memory without the window, or both.

- **Memory server** (`skeinwise mcp`): `search`, `ask`, `read_entry`, `read_thread`, `timeline`, `list_hubs`,
  `read_hub`, `write_note`, `append_daily_note`, `tag_entries`, `not_mine`, `undo_run`.
- **Window server** (`skeinwise mcp --window`): `show_in_brain`, `open_entry`, `open_hub`, `set_layout`,
  `highlight` (moves the app's view while you watch).
- **Config snippets** for Claude Code, Claude desktop, Codex, Cursor and others, ready to copy.
- Every agent write is a version under the agent's name.
- Before an agent's first read, the app asks you to allow it. Lock stops all tools.

## Ledger and proof of date

- Every import, edit and run appends a line to `ledger.jsonl`, with a hash chained to the line before. Any later
  change to the ledger breaks the chain and shows.
- Optionally, the latest ledger hash is stamped with OpenTimestamps to prove the record existed at that date. The
  proof is collected a few hours later and stored next to the ledger.

## Encrypted sync

- Sync writes an encrypted bundle of the record to any folder you pick, such as a cloud drive folder.
- A random key encrypts the bundle (AES-256-GCM). That key is stored twice: once wrapped by a key from your
  passphrase, and once by a key from a 24-word recovery phrase that is shown only once. Both keys are derived with
  scrypt.
- Another computer joins with the passphrase, or restores with the recovery phrase.
- Nothing goes to a Skeinwise server, because there isn't one.

## Command line

| Command | Does |
|---|---|
| `skeinwise init` | Creates the record folder |
| `skeinwise import <path>…` | Imports exports, history folders or note folders |
| `skeinwise search <words>` | Full-text search |
| `skeinwise ask <question>` | A question, answered as a view |
| `skeinwise run <task> [--scope new]` | Runs an organiser task |
| `skeinwise runs`, `skeinwise undo <run>` | Lists runs; undoes one |
| `skeinwise note <text>` | Appends to today's daily note |
| `skeinwise live` | Turns on the update stream: live capture and background organising |
| `skeinwise model check`, `fetch`, `serve` | Tests, downloads (after asking) or starts the local model |
| `skeinwise serve` | Starts the app |
| `skeinwise mcp [--window]` | Starts the memory server, or the window server |
| `skeinwise demo` | Builds a demo record from invented data |
| `skeinwise export` | Writes a zip of the record |

