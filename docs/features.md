# Skeinwise: features

## The record

The record is one SQLite file, `~/.skeinwise/record.db`, plus Markdown notes in `~/.skeinwise/notes`.

- **Tables:** sources, threads, entries and versions.
- **Entry:** one message, note or file, with a kind, a speaker (you, an assistant or a named person), a thread, a
  source, a created date and a content hash.
- **Originals are append-only.** An edit adds a version with its editor and date; nothing is overwritten.
- **"Not mine":** a conversation marked this way leaves the Map, search and notes, but stays in history.

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
- Results can be shown as points in the Map.

## Ask

A question in plain words becomes a view. The organiser picks the entries that answer it and lists them by date, with
your own quotes first. Patterns include "when did I first …", "what did I decide about …" and "what changed in my
thinking on …".

- **With a model engine,** a short answer sits on top and cites entry ids.
- **With No AI,** the view is built from search and dates alone.

## The organiser and runs

| Task | What it makes |
|---|---|
| tag | Tags on entries |
| file | Entries filed into folders |
| link | Cross links between entries |
| hub | Topic hubs: In short, What you found, Open ends |
| layer | Cleaned, Expanded, Digest and Ideas layers for an entry |
| review | Notes that may be out of date |

- **Each pass is a run,** with its task, engine, model, scope, status, counts, token use, and start and end times.
- Everything a run makes records the run's id, and **Undo run** deletes all of it.
- A run over a large scope shows a size estimate first and waits for approval.

## Engines

- **No AI:** keyword extraction (TF-IDF over the record), k-means clustering of term vectors for hubs and folders,
  similarity for links, and extractive summaries for layers.
- **Model:** any OpenAI-compatible chat endpoint (llama.cpp's `llama-server`, Ollama, LM Studio, or a hosted API with
  a key). The model is asked for JSON, and its output is checked before anything is saved.
- The same tasks work with either engine.

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
- **Exclude a source.** Its entries leave the Map and search; you can include it again later.

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

- With No AI or a local engine, nothing leaves the computer.
- **Redaction:** before any text goes to a hosted model, names, emails, phone numbers, street addresses and health
  terms are replaced with placeholders. A preview shows exactly what will be sent.
- **Budget:** a monthly token cap pauses runs until the month resets.
- **The record folder** is created with owner-only permissions.
- **The server** listens on 127.0.0.1 only and needs a per-install token.

## Agent memory (MCP)

A local MCP server over stdio.

- **Tools:** `search`, `ask`, `read_entry`, `read_thread`, `timeline`, `list_hubs`, `read_hub`, `write_note`,
  `append_daily_note`, `tag_entries`, `undo_run`, `show_in_map` (moves the app's view).
- **Config snippets** for Claude Code, Claude desktop, Codex, Cursor and others, ready to copy.
- Every agent write is a version under the agent's name.
- Lock stops all tools.

## Live capture

When it's on, Skeinwise watches the Claude Code and Codex history folders and the note folders you chose, and imports
new entries within seconds. It also checks Downloads for new ChatGPT, Claude and Gemini export files. The capture bar
shows the last save and what was caught up.

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
| `skeinwise run <task>` | Runs an organiser task |
| `skeinwise runs`, `skeinwise undo <run>` | Lists runs; undoes one |
| `skeinwise note <text>` | Appends to today's daily note |
| `skeinwise serve` | Starts the app |
| `skeinwise mcp` | Starts the agent server |
| `skeinwise demo` | Builds a demo record from invented data |
| `skeinwise export` | Writes a zip of the record |

---

## How this document was written

A small model running on this machine drafted it: Qwen3-4B (Q4_K_M GGUF from ggml-org on Hugging Face) under
llama.cpp's `llama-server`, temperature 0.4, thinking off, one section at a time from a short outline. The drafts were
then checked and corrected by hand. The corrections:

- **Padding cut,** including a correction section that repeated "reversible" nine times.
- **Made-up claims removed:** live capture "across devices", notes reachable "from any device", and a summary that
  every importer "organises tags, links and summaries".
- **Sync design made precise.** The draft said the recovery phrase "is not used for encryption", which would make
  recovery impossible. Both the passphrase and the recovery phrase now wrap the bundle key.
- **Command line fixed.** The draft described `import` as taking "a directory of files" and `undo` as reverting "a
  task".
