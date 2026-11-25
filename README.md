# Skeinwise

**A second brain that organises itself.** Skeinwise gathers your AI conversations, your notes and the folders you
choose into one dated record on your own computer, and keeps it current as you work: new chats and notes come in live,
and a small AI model running on your machine tags, files, links and summarises them in the background, without
changing a word you wrote. You can explore the result as a 3D brain, ask it questions in plain words, or lend it to
your AI tools as long-term memory.

> **Status:** v0.1.0, the record and the command line. Each milestone below ships as a tagged release.

## Why

You think out loud in chats with ChatGPT, Claude, Gemini, Claude Code and Codex, and in your notes. That thinking ends
up scattered across export files and history folders that no single tool reads. Skeinwise winds those threads into one
skein:

- **Nothing is lost or rewritten.** Originals are append-only. Everything a machine adds sits in its own layer,
  labelled with the engine, model and run that made it, and you can undo any run.
- **Local first.** Everything lives in one folder on your machine (`~/.skeinwise`). Nothing leaves it unless you turn
  on a route.
- **Its own AI, on your computer.** The built-in engine is a small local model (Qwen3-4B is the suggestion) served by
  llama.cpp or Ollama. You can point it at an outside model instead, or turn AI off and let keyword statistics and
  clustering do the organising.
- **Plain data.** The record is one SQLite file plus your Markdown notes.
- **Ready for agents.** Two MCP servers give Claude Code, Codex, Cursor and other tools memory over your record and a
  way to steer the app's view.

## Roadmap

| Release | What it brings |
|---|---|
| v0.1.0 | The record: importers for ChatGPT, Claude, Gemini, Claude Code, Codex, Markdown folders and text; dedupe and versions; full-text search; the `skeinwise` command; a demo record |
| v0.2.0 | The organiser: the local model (default), an outside model or No AI; runs with provenance and undo; corrections; notes; review; ask |
| v0.3.0 | The update stream: live capture and background organising of what's new; `skeinwise model` to check or fetch the local model |
| v0.4.0 | The app: first run, the 3D brain, Navigator, the reader, concept hubs, timeline, year rings, the Lab, themes, the command bar and settings |
| v0.5.0 | Agents and safety: the memory and window MCP servers; the ledger with date proofs; encrypted sync |

## Quick start

You need Node 24 or later and pnpm.

```bash
git clone https://github.com/buzludeniz/skeinwise
cd skeinwise
pnpm install
pnpm build
```

Try it on the invented demo record first, kept in its own folder:

```bash
export SKEINWISE_HOME=~/skeinwise-demo
node dist/src/cli.js demo
node dist/src/cli.js search "what did I decide about sqlite"
node dist/src/cli.js stats
```

Then bring in your own data. The record lives in `~/.skeinwise` unless `SKEINWISE_HOME` says otherwise.

```bash
unset SKEINWISE_HOME
node dist/src/cli.js import ~/Downloads/chatgpt-export.zip ~/Downloads/claude-export.zip
node dist/src/cli.js import ~/.claude/projects ~/.codex/sessions
node dist/src/cli.js import ~/Notes
node dist/src/cli.js search sourdough starter
```

| Source | Where to get it |
|---|---|
| ChatGPT | Settings → Data controls → Export data; import the zip |
| Claude | Settings → Privacy → Export data; import the zip |
| Gemini | Google Takeout → My Activity → Gemini Apps (JSON); import the zip |
| Claude Code | `~/.claude/projects` |
| Codex | `~/.codex/sessions` |
| Markdown, Obsidian, plain text | The folder itself; `--owner <name>` when the words are someone else's |

Importing again is safe: entries already in the record are skipped, and changed text becomes a new version. Run
`node dist/src/cli.js help` for every command.

## Docs

- [Plan](docs/plan.md): stack, architecture, scope and milestones
- [Research](docs/research.md): the export formats and the landscape
- [UI](docs/ui.md) and [features](docs/features.md): the detailed design

## Licence

[MIT](LICENSE) © 2026 Deniz Ikili
