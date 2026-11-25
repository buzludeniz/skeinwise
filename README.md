# Skeinwise

**A second brain that organises itself.** Skeinwise gathers your AI conversations, your notes and the folders you
choose into one dated record on your own computer. Local agents then tag, file, link and summarise that record without
changing a word you wrote. You can explore the result as a 3D map, ask it questions in plain words, or lend it to your
AI tools as long-term memory.

> **Status:** early and moving fast. Each milestone below ships as a tagged release.

## Why

You think out loud in chats with ChatGPT, Claude, Gemini, Claude Code and Codex, and in your notes. That thinking ends
up scattered across export files and history folders that no single tool reads. Skeinwise winds those threads into one
skein:

- **Nothing is lost or rewritten.** Originals are append-only. Everything a machine adds sits in its own layer,
  labelled with the engine, model and run that made it, and you can undo any run.
- **Local first.** Everything lives in one folder on your machine (`~/.skeinwise`). Nothing leaves it unless you turn
  on a route.
- **Works with no AI.** A built-in engine organises the record with keyword statistics and clustering. A small local
  model (through llama.cpp or Ollama) or any OpenAI-compatible endpoint makes the results better.
- **Plain data.** The record is one SQLite file plus your Markdown notes.
- **Ready for agents.** An MCP server gives Claude Code, Codex, Cursor and other tools search, read and note tools over
  your record.

## Roadmap

| Release | What it brings |
|---|---|
| v0.1.0 | The record: importers for ChatGPT, Claude, Gemini, Claude Code, Codex, Markdown folders and text; dedupe and versions; full-text search; the `skeinwise` command; a demo record |
| v0.2.0 | The organiser: the No-AI engine and the model engine; runs with provenance and undo; corrections; notes; review |
| v0.3.0 | The app: onboarding, the 3D brain, the reader, hubs, timeline, year rings, the lab, themes, the command bar and settings |
| v0.4.0 | Agents and safety: the MCP server and window control; live capture; the ledger with date proofs; encrypted sync |

## Quick start

You need Node 24 or later and pnpm.

```bash
git clone https://github.com/buzludeniz/skeinwise
cd skeinwise
pnpm install
pnpm dev --help
```

## Docs

- [Plan](docs/plan.md): stack, architecture, scope and milestones
- [Research](docs/research.md): the export formats and the landscape
- [UI](docs/ui.md) and [features](docs/features.md): the detailed design

## Licence

[MIT](LICENSE) © 2026 Deniz Ikili
