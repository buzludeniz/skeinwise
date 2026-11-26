<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-lockup-dark.svg">
    <img src="docs/brand/logo-lockup-light.svg" alt="Skeinwise" width="320">
  </picture>
</h1>

**A second brain that organises itself.** Skeinwise gathers your AI conversations, your notes and the folders you
choose into one dated record on your own computer, and keeps it current as you work: new chats and notes come in live,
and a small AI model running on your machine tags, files, links and summarises them in the background, without
changing a word you wrote. You can explore the result as a 3D brain, ask it questions in plain words, or lend it to
your AI tools as long-term memory.

> **Status:** 1.0.0 is in its final checks and not on npm yet. Until it is, run it from a clone: see
> [From a clone](#from-a-clone).

## Why

You think out loud in chats with ChatGPT, Claude, Gemini, Claude Code and Codex, and in your notes. That thinking ends
up scattered across export files and history folders that no single tool reads. Skeinwise winds those threads into one
skein:

- **Nothing is lost or rewritten.** Originals are append-only. Everything a machine adds sits in its own layer,
  labelled with the engine, model and run that made it, and you can undo any run.
- **Local first.** Everything lives in one folder on your machine (`~/.skeinwise`). Nothing leaves it unless you turn
  on a route. [Security](docs/security.md) lists every route.
- **Its own AI, on your computer.** The built-in engine is a small local model (Qwen3-4B is the suggestion) served by
  llama.cpp or Ollama. You can point it at an outside model instead, or turn AI off and let keyword statistics and
  clustering do the organising.
- **Plain data.** The record is one SQLite file plus your Markdown notes.
- **Ready for agents.** Two MCP servers give Claude Code, Codex, Cursor and other tools memory over your record and a
  way to steer the app's view.
- **Sized for a big record.** 1.0 supports records of up to 50,000 entries. On an M1 with 16 GB, 50,000 entries
  import in 8 seconds or less, a search returns in 150 ms or less, and a question answered without AI takes 1 second
  or less.

## Roadmap

| Release | What it brings |
|---|---|
| v0.1.0 | The record: importers for ChatGPT, Claude, Gemini, Claude Code, Codex, Markdown folders and text; dedupe and versions; full-text search; the `skeinwise` command; a demo record |
| v0.2.0 | The organiser: the local model (default), an outside model or No AI; runs with provenance and undo; corrections; notes; review; ask |
| v0.3.0 | The update stream: live capture and background organising of what's new; `skeinwise model` to check or fetch the local model |
| v1.0.0 | The app: first run, the 3D brain, the reader, hubs, the timeline, themes, the command bar and settings. Agent memory over MCP, with a token for each agent. `setup`, `connect` and `doctor`. Export. Word (.docx) imports. Install with `npx` |
| v1.1 | Work tools: read-only Gmail, Google Calendar, Todoist and Slack connectors, and the rest of [Coming in 1.1](#coming-in-11) |

## Coming in 1.1

These were planned for 1.0 and moved to 1.1, so that 1.0 ships with every check it was meant to pass:

- **Work tools:** read-only Gmail, Google Calendar, Todoist and Slack connectors.
- **More file types:** PDF, RTF, HTML and ODT. 1.0 imports Word (.docx), plain text (.txt) and Markdown (.md).
- **Search ranked by relevance alone,** without putting your own words first, with results grouped by conversation.
- **The whole brain at any size:** zooming in loads the detail past the first 20,000 points. 1.0 shows a sample of
  20,000 and says so.
- **Obsidian aliases and folder links:** `[[Note|alias]]` and `[[Folder/Note]]`. 1.0 keeps a note's front matter,
  its tags included, and skips your templates.
- **Streaming beyond `ask`:** layers, hubs, review and the brief appear as they are written. In 1.0, `ask` streams and
  can be cancelled, and the rest show a progress line.
- **Held imports in the app:** a card for an export that waits for your yes. In 1.0 you review them with
  `skeinwise live pending`.
- **A first run with three doors:** try the demo, bring in an export while the demo plays, or connect an agent.
- **Choosing which projects come in:** one row for each Claude Code or Codex project, and a way to leave a source out
  later.
- **Readable titles everywhere:** one readable title and a clean snippet for every entry, in every view.
- **More of the clickable brain,** past its first phase.
- **`skeinwise purge`:** removes an entry and all its versions for good, for a secret pasted into a chat.

## Quick start

You need Node 24 or later. Try it on the invented demo record first, kept in its own folder:

```bash
export SKEINWISE_HOME=~/skeinwise-demo
npx skeinwise demo
npx skeinwise serve --open
```

`serve` opens the app in your browser, on this computer only. To keep the `skeinwise` command, install it once with
`npm install --global skeinwise`; the rest of this page uses it.

```bash
skeinwise search "what did I decide about sqlite"
skeinwise stats
```

Organise it. With no model server running, `--engine none` uses keyword statistics; with the local model running (see
[the organiser](docs/organiser.md)), leave it off.

```bash
skeinwise run all --engine none
skeinwise hubs
skeinwise ask "what did I decide about sqlite" --engine none
skeinwise review
skeinwise runs
```

To organise with the built-in AI, fetch and start the local model (about 2.5 GB, after asking; llama.cpp's
`llama-server` must be installed, for example with `brew install llama.cpp`):

```bash
skeinwise model fetch
skeinwise model serve --run    # in its own terminal
skeinwise model check
skeinwise run all
```

Then bring in your own data. The record lives in `~/.skeinwise` unless `SKEINWISE_HOME` says otherwise. `setup` finds
your AI histories and notes, lists them, and asks before it brings them in:

```bash
unset SKEINWISE_HOME
skeinwise setup
```

Or name what to import:

```bash
skeinwise import ~/Downloads/chatgpt-export.zip ~/Downloads/claude-export.zip
skeinwise import ~/.claude/projects ~/.codex/sessions
skeinwise import ~/Notes ~/Documents/plans.docx
skeinwise search sourdough starter
```

| Source | Where to get it |
|---|---|
| ChatGPT | Settings → Data controls → Export data; import the zip |
| Claude | Settings → Privacy → Export data; import the zip |
| Gemini | Google Takeout → My Activity → Gemini Apps (JSON); import the zip |
| Claude Code | `~/.claude/projects` |
| Codex | `~/.codex/sessions` |
| Markdown, Obsidian, plain text, Word | The file or folder: `.md`, `.txt` and `.docx` files; `--owner <name>` when the words are someone else's |

Importing again is safe: entries already in the record are skipped, and changed text becomes a new version.

Keep it current with the update stream. After one `run all`, `live` imports new Claude Code and Codex chats, and the
Markdown, text and Word files in the folders you name, as they appear, and organises what is new in the background.
With `config liveDownloads on`, an export that lands in Downloads waits for your yes in `live pending`:

```bash
skeinwise config liveFolders ~/Notes
skeinwise live
```

Lend the record to an agent as its memory. `connect` shows the change to the agent's config and asks before it makes
it, keeping a copy of the old file. The agent gets read access; `--write` lets it write notes and tags too:

```bash
skeinwise connect claude-code
skeinwise doctor
```

Take a plain-text copy of the record, as a zip on this computer:

```bash
skeinwise export
```

Run `skeinwise help` for every command.

## From a clone

To run the newest code, or to work on Skeinwise, you need Node 24 or later and pnpm:

```bash
git clone https://github.com/buzludeniz/skeinwise
cd skeinwise
pnpm install
pnpm build
node dist/src/cli.js demo
```

`node dist/src/cli.js` then stands in for `skeinwise` in every command above.

## Docs

- [Plan](docs/plan.md): stack, architecture, scope and milestones
- [The organiser](docs/organiser.md): engines, the local model, runs, undo, hubs, asking and review
- [Export](docs/export.md): what the zip holds and where each part goes
- [Agent memory (MCP)](docs/mcp.md): the two servers, config for each agent, and allowing an agent
- [Security](docs/security.md): what leaves your computer, who it defends against, the Lock, agent scopes and
  redaction. To report a problem, see [SECURITY.md](SECURITY.md)
- [Connectors](docs/connectors.md) *(1.1)*: what each one reads, its permissions, and how to make your own client
- [Research](docs/research.md): the export formats and the landscape
- [UI](docs/ui.md) and [features](docs/features.md): the detailed design
- [Changelog](CHANGELOG.md): what each release changed

## Licence

[MIT](LICENSE) © 2026 Deniz Ikili
