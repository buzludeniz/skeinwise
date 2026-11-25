# Skeinwise: plan

Skeinwise is a second brain that organises itself. It takes in your AI conversations, your notes and the folders you
choose, dates every entry, and lets local agents tag, file, link and summarise them, without changing a word you
wrote. You explore the result as a living 3D map, ask it questions in plain words, and lend it to your own AI agents
as long-term memory. Everything stays on your computer.

## Principles

1. **Your words are never rewritten.** Originals are append-only. Everything a machine adds (tags, folders, links,
   summaries, rewrites) lives in a separate layer, labelled with the engine, model and run that made it, and every run
   can be undone.
2. **Local first.** The record is a folder on your machine. Nothing leaves it unless you switch on a route, and the
   default engine is a small model on your own computer, or no model at all.
3. **Works with no AI.** A deterministic engine (keyword statistics, clustering and similarity) organises the whole
   record offline. A model makes it better, never possible.
4. **Plain, portable data.** One SQLite file plus your Markdown notes. Any tool can read them, and the index can be
   rebuilt.
5. **Everything a click can do, an agent can do.** The UI and the agent tools share one API.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 26, TypeScript, pnpm | One language end to end; `node:sqlite` is built in |
| Store | `node:sqlite` (SQLite 3.54, FTS5) | No native build step, full-text search included |
| Server | `node:http` with a small router | No framework needed for a local API |
| UI | Vite, Preact, three.js | Small bundle, real 3D |
| Engine | No-AI (built in) or any OpenAI-compatible endpoint (llama.cpp `llama-server`, Ollama, LM Studio, hosted) | Local by default |
| Agents | MCP server over stdio (`@modelcontextprotocol/sdk`) | Claude Code, Codex, Cursor and others connect with one config |
| Tests | Vitest (unit and integration), Playwright (end to end) | |
| CI | GitHub Actions: typecheck, test, build | Every push |

## Architecture

```
sources ──► importers ──► record (SQLite: sources, threads, entries, versions)   ◄── originals, append-only
                              │
                              ├─► index (FTS5 + term vectors)
                              │
engine (No-AI | model) ──► runs ──► derived layer (tags, folders, links, hubs, layers, notes)  ◄── undoable
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

Onboarding (Welcome, Set Up, Bring In, Watch It Grow) · rail with Search ⌘K, Brain, Navigator, Numbers, Timeline, You,
Lab, Learn, Add · the 3D Brain · entry reader with its layers and history · hub panel · year rings · table builder
and tides · notes editor with `[[links]]` and a daily note · review queue · capture bar (live capture, add files,
request an export, lock) · settings (engine, budget, privacy, agents, sync, proof of date, exclusions) · themes and
palettes. Full detail: [ui.md](ui.md).

### Features

Importers (ChatGPT, Claude, Gemini, Claude Code, Codex, Markdown and Obsidian folders, plain text) · dedupe and
versions · full-text and similarity search · questions answered as views · tagging, filing, linking, hubs and
summary layers · tagging schemas with sized runs and coverage · corrections (edit, merge folders, not mine, exclude
a source, undo) · note review for staleness · redaction before any outside model, and a budget cap · MCP agent tools
· live capture of agent histories and followed folders · tamper-evident ledger with date proofs · encrypted sync
bundles. Full detail: [features.md](features.md).

### Not in scope (yet)

A browser extension, Notion, Evernote and Slack connectors, mobile apps, a hosted sync service.

## Milestones (each one a tagged release)

| Tag | Delivers |
|---|---|
| v0.1.0 | Record store, importers, dedupe and versions, search, CLI, demo record |
| v0.2.0 | No-AI and model engines, runs with provenance and undo, corrections, notes, review |
| v0.3.0 | Web UI: onboarding, 3D brain, reader, hubs, timeline, lab, themes, command bar, settings |
| v0.4.0 | MCP server and window control, live capture, ledger, encrypted sync |

## How the detail docs were written

`ui.md` and `features.md` were drafted by a small language model running locally (llama.cpp), from an outline, then
checked and corrected by hand. The notes at the end of each file say which model was used.
