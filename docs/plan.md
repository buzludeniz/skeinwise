<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo-mark-dark.svg">
  <img src="brand/logo-mark.svg" alt="" width="40" height="40">
</picture>

# Skeinwise: plan

Skeinwise is a second brain that organises itself. It takes in your AI conversations, your notes and the folders you
choose, dates every entry, and lets local agents tag, file, link and summarise them, without changing a word you
wrote. You explore the result as a living 3D map, ask it questions in plain words, and lend it to your own AI agents
as long-term memory. Everything stays on your computer.

## Principles

1. **Your words are never rewritten.** Originals are append-only. Everything a machine adds (tags, folders, links,
   summaries, rewrites) lives in a separate layer, labelled with the engine, model and run that made it, and every run
   can be undone.
2. **Local first.** The record is a folder on your machine. Nothing leaves it unless you switch on a route. The
   built-in AI is a small model on your own computer, and it is the default.
3. **It keeps itself current.** Live capture brings new chats and notes in as they happen, and the local model tags,
   files, links and summarises them in the background. You never have to run an import or an organising pass by hand.
4. **Works with no AI too.** A deterministic engine (keyword statistics, clustering and similarity) organises the
   whole record offline for people who want no model at all.
5. **Plain, portable data.** One SQLite file plus your Markdown notes. Any tool can read them, and the index can be
   rebuilt.
6. **Everything a click can do, an agent can do.** The UI and the agent tools share one API.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 26, TypeScript, pnpm | One language end to end; `node:sqlite` is built in |
| Store | `node:sqlite` (SQLite 3.54, FTS5) | No native build step, full-text search included |
| Server | `node:http` with a small router | No framework needed for a local API |
| UI | Vite, Preact, three.js, Lucide icons | Small bundle, real 3D, open-licensed icons |
| Engine | A local model through an OpenAI-compatible server (llama.cpp `llama-server` or Ollama; Qwen3-4B suggested) by default, an outside endpoint, or No AI | The built-in AI runs on your computer |
| Agents | An MCP server over stdio (`@modelcontextprotocol/sdk`) for memory; the window server is not in 1.0 | Claude Code, Codex, Cursor and others connect with one config |
| Tests | Vitest (unit and integration), Playwright (end to end) | |
| CI | GitHub Actions: typecheck, test, build | Every push |

## Architecture

```
sources ──► live capture / importers ──► record (SQLite: sources, threads, entries, versions)   ◄── originals, append-only
                              │
                              ├─► index (FTS5 + term vectors)
                              │
engine (local | outside | none) ──► runs ──► derived layer (tags, folders, links, hubs, layers, notes)  ◄── undoable
                              │
            ┌─────────────────┼──────────────────┐
           CLI          HTTP API + UI        MCP server
```

- **Home folder:** `~/.skeinwise` (override with `SKEINWISE_HOME`): `record.db`, `notes/` (Markdown), `config.json`,
  `ledger.jsonl`.
- **Entry:** one message or one note or file, with `kind`, `speaker` (you, assistant or another named person),
  `thread_id`, `source_id`, `created_at` and `content_hash`. Re-importing the same item adds a version, never a
  duplicate.
- **Run:** one pass of an engine task (`tag`, `file`, `link`, `hub`, `layer`, `review`), with engine, model, scope,
  status, counts and a cost estimate. Undoing a run removes everything it derived.

## Scope

### Screens

App menu (command bar, add files, Live capture with status lines, connect, get an export, lock, settings) · first
run (Set up, Bring in, Watch it grow) · rail with Brain, Threads, Stats, Timeline, Profile, Workbench, Views,
Assistant, Guide and + Add · the 3D brain, a point cloud that opens as one disc per group, with a Brain layout of two lobes and a stem ·
Guide panel · concept hub panel · entry reader with its layers and history · the Activity layout · timeline ·
Workbench (the table builder and Activity) · notes editor with `[[links]]` and a daily note · review queue · compact
window · settings (agents, AI model, usage cap, backup, exclusions, appearance) · six themes and seven
palettes. Full detail: [ui.md](ui.md).

### Features

The update stream (live capture plus background organising by the local model) · importers (ChatGPT, Claude,
Gemini, Claude Code, Codex, Markdown and Obsidian folders, plain text) · dedupe and versions · full-text and similarity search · questions answered as views · tagging, filing, linking, hubs and
summary layers · tagging schemas with sized runs and coverage · corrections (edit, merge folders, not mine, exclude
a source, undo) · note review for staleness · redaction before any outside model, and a usage cap · memory and window MCP servers · export
to a plain zip. Planned, not in 1.0: the tamper-evident ledger with date proofs, and daily backups. Full detail: [features.md](features.md).

### Not in scope (yet)

A browser extension, Notion and Evernote connectors, mobile apps, sync between computers, a hosted sync service.

## Milestones (each one a tagged release)

| Tag | Delivers |
|---|---|
| v0.1.0 | Record store, importers, dedupe and versions, search, CLI, demo record |
| v0.2.0 | The organiser: the local model (default), outside model and No-AI engines; runs with provenance and undo; `--scope new`; corrections; notes; review; ask |
| v0.3.0 | The update stream: live capture, background organising of new entries, `skeinwise model` |
| v1.0.0 | The app: first run, the 3D brain, the reader, hubs, the timeline, themes, the command bar and settings. Agent memory over MCP, with a token for each agent. `setup`, `connect` and `doctor`. Export. Word (.docx) imports |
| v1.1 | Work tools: read-only Gmail, Google Calendar, Todoist and Slack connectors, and the rest of README's [Coming in 1.1](../README.md#coming-in-11) |

History: the first plan split the app and the MCP servers into v0.4.0 and v0.5.0; they ship together as v1.0.0.

