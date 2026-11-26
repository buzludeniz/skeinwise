# Changelog

Every release of Skeinwise, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/). A release's notes on GitHub are its section here.

## [Unreleased]

What 1.0.0 brings. This section becomes `## [1.0.0]` when the version is bumped for the release.

### Added

- **The app.** `skeinwise serve` opens Skeinwise in your browser, on this computer only (127.0.0.1, with a token).
  It includes the 3D brain, Navigator, the reader, concept hubs, the runs and their undo, the command bar, settings,
  and light and dark themes.
- **Agent memory over MCP.** `skeinwise mcp` serves your record to Claude Code, Codex, Cursor, Claude desktop and
  other MCP clients:
  - seven read tools, plus five write tools for an agent you give write scope;
  - each agent has its own token and starts with read scope;
  - `skeinwise mcp lock` stops every agent at once;
  - `skeinwise mcp log` shows every call;
  - the tools that change what is yours (`not_mine`, `undo_run`) wait for your yes.
- **`skeinwise connect`, `setup` and `doctor`.** Connect an agent with one command, find the histories on this
  computer, and check that everything Skeinwise needs is in place.
- **`skeinwise export`.** The record as Markdown and JSON in a zip on this computer.
- **The local model.** `skeinwise model fetch` downloads the suggested model, pinned to a commit and checked by size
  and SHA-256. `skeinwise model serve --run` starts llama-server locked to this record with its own key, and
  `skeinwise model check` checks it.
- **Install with npm.** `npx skeinwise` and `npm install -g skeinwise`. On a Node older than 24, the command stops
  with a link to install a current one.

### Changed

- The work-tool connectors (Gmail, Google Calendar, Todoist and Slack) move to 1.1.
- Encrypted sync is hidden in 1.0. Export stays.
- `skeinwise stats` prints the busiest months as plain text.

### Security

- Everything Skeinwise prints passes through one output sanitiser, so text you import can't send escape codes to your
  terminal.
- Text sent to a remote model always has keys, tokens and similar secrets replaced, even with `redaction off`. The
  personal patterns (emails, phone numbers, addresses, health words, the names you list) are wider.
- A remote model needs an https address on a host you confirmed. Requests never follow a redirect, and token use is
  counted honestly, including when a server reports none.
- Agents get results framed as untrusted data, with secrets redacted, cut to 20 entries and 32 KB.
- `record.db` and its WAL files are readable by you only, on macOS and Linux.
- Hubs and review no longer build on text planted to pass as your latest word.
- Releases are built by GitHub Actions from a signed tag on main and published to npm with provenance, with no npm
  token stored anywhere. Every action is pinned by commit, and CI runs on macOS, Windows and Ubuntu with Node 24
  and 26. [docs/security.md](docs/security.md) describes the threat model and the limits.

## [0.3.0] - 2026-11-25

The update stream.

### Added

- `skeinwise live` brings in new Claude Code and Codex chats, export files in Downloads, and the note folders you
  name as they appear, then organises what is new in the background.
- `skeinwise model` checks or fetches the local model.

## [0.2.0] - 2026-11-25

The organiser.

### Added

- Three engines: the local model (the default), an outside model, or No AI (keyword statistics and clustering).
- Runs, each recorded with its engine, model and settings, and undo for any run.
- Corrections, your own notes, review and `ask`.

## [0.1.0] - 2026-11-25

The record and the command line.

### Added

- Importers for ChatGPT, Claude, Gemini, Claude Code, Codex, Markdown folders and plain text.
- Dedupe and versions: importing again skips what is already in the record, and changed text becomes a new version.
- Full-text search, the `skeinwise` command and an invented demo record.

[Unreleased]: https://github.com/buzludeniz/skeinwise/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/buzludeniz/skeinwise/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/buzludeniz/skeinwise/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/buzludeniz/skeinwise/releases/tag/v0.1.0
