<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo-mark-dark.svg">
  <img src="brand/logo-mark.svg" alt="" width="40" height="40">
</picture>

# Skeinwise: security

Skeinwise holds what you said to AI tools and wrote in your notes, and people paste secrets into chats. This page
covers what it defends against, what leaves your computer, and where its protections stop. To report a problem,
see [SECURITY.md](../SECURITY.md).

## What leaves your computer

By default, nothing. Importing, searching, organising with No AI or the local model, `live`, `serve`, `export` and
the agent servers all stay on this computer. Skeinwise has no account, no telemetry and no update check.

| When | What goes out | Where it goes | How to keep it in |
|---|---|---|---|
| `skeinwise model fetch`, after you say yes | A download request for one model file. Nothing from your record. | huggingface.co, for the file pinned to a commit. The download is checked against its size and SHA-256. | Don't run it, or put a model file in `models/` yourself. |
| A run with the remote engine (`--engine remote`, only once you set `remoteUrl`, `remoteModel` and `apiKeyEnv`) | The text of the entries that run works on, redacted (see below), and your key | The https address you set, and only if you confirmed its host in `remoteHosts`. No redirect is followed, and a monthly token budget caps use. | Use No AI or the local model. `--preview` prints exactly what a run would send. |
| An agent you connected reads your record (MCP) | Its tools' results, sent to the agent on this computer | The agent, which passes them to the model it runs on, often a cloud service | Allow only agents whose model you trust with that text. `skeinwise mcp deny <agent>` or `skeinwise mcp lock` stops them. |

Calls that stay on this computer:

- The local engine and the `doctor` and app model checks talk only to a server on 127.0.0.1, localhost or ::1. A
  local address on another computer is refused.
- The app listens on 127.0.0.1 only.
- The agent servers talk over stdio, with no network port.

Installing with `npx` or `npm` talks to the npm registry, as any package does. The work-tool connectors and
encrypted sync are not part of 1.0.

## Who it defends against

| Who | How they reach Skeinwise | What stands in the way |
|---|---|---|
| Someone who gets a file onto your computer: a download, a shared export, a cloned repo with a crafted session, a synced vault | `import`, `live`'s folders and Downloads, the app's file drop | Importers treat every file as untrusted. Text from them is printed through one sanitiser, so it can't send escape codes to your terminal. Hubs and review don't build on text planted to pass as your latest word. |
| Text inside a chat, written to steer a model (prompt injection) | The organiser's prompts, `ask`, hub summaries, review, and agents reading through MCP | The organiser's model has no tools. Agents get every result as data marked untrusted, never as instructions. Each machine-made change is a recorded run you can undo, and an agent's requests to hide a chat or undo a run wait for your yes. |
| A web page open in your browser | Requests to the app or the local model server on 127.0.0.1, including DNS rebinding | The app checks every request's Host and Origin and needs a per-install token. `model serve --run` starts the model server with its own key. |
| A connected agent that was itself misled, or is careless | The MCP tools | Each agent has its own token and starts with read scope. Results are capped at 20 entries and 32 KB a call, and 500 KB a session. Every call is logged, and the lock stops them all. |
| A hostile or mistyped remote model address | The remote engine | https only, on hosts you confirmed. Secrets are always redacted, redirects are never followed, and every run is recorded. |
| The supply chain: npm packages, the model file, GitHub Actions, the release itself | Install, `model fetch`, CI | One runtime dependency (fflate) and a locked install. The model file is pinned by commit and SHA-256. Actions are pinned by commit. Releases come from a signed tag with npm provenance (below). |
| Another person with an account on the same computer | File permissions, the loopback ports | On macOS and Linux the record folder is 0700 and `record.db` 0600, and `skeinwise doctor` checks both. The app's token guards the port. |

Out of scope:

- **Someone holding your unlocked computer, or a thief with your disk.** Use your OS's disk encryption and screen
  lock: the record is a plain SQLite file and Markdown, not encrypted.
- **Malware running as you.** It can read anything you can, the record included.

Trust boundaries:

- Files on disk and in Downloads are untrusted.
- Text in the record is never an instruction, even your own: your chats quote other people and other models.
- The network is untrusted, except the addresses you name.
- The loopback interface is untrusted too, since browsers and other users on the computer reach it.

## The Lock, and what it doesn't do

There are two locks.

- **`skeinwise mcp lock`** stops every tool of every agent, from its next call, until `skeinwise mcp unlock`. It is
  kept in the record folder, so it holds across restarts.
- **The app's Lock** (the menu, or `lock` in the command bar) covers the window, and the app refuses its own requests
  until you click Unlock. It is a curtain, not a password:
  - Unlock takes one click, with no password.
  - It lasts only while that `skeinwise serve` runs. Starting the app again starts it unlocked.
  - It doesn't stop agents. Use `skeinwise mcp lock` for that.
  - It doesn't encrypt anything, and the command line reads the record as usual.

## Agents: tokens and scopes

[Agent memory](mcp.md) has the details. In short:

- `skeinwise connect <agent>` or `skeinwise mcp allow <agent>` gives the agent a token, shown once. The record keeps
  only its SHA-256. Allowing the agent again replaces the token, and `skeinwise mcp deny` takes it back.
- **Read scope**, the default, gives seven tools: `search`, `ask`, `read_entry`, `read_thread`, `timeline`,
  `list_hubs` and `read_hub`.
- **Write scope** (`--write`) adds five tools: `write_note`, `append_daily_note` and `tag_entries`, which act as runs
  you can undo, and `not_mine` and `undo_run`, which only file a request for you to confirm.
- `skeinwise mcp log` lists every call: what was asked, and what was sent.

The limits:

- The token is a password stored in the agent's config file, and anything that can read that file can use it.
- An agent with read scope can read the whole record, apart from sources you left out and conversations marked
  "not mine".
- What it reads goes on to its model (see the first table).

## Redaction, and its limits

Redaction replaces sensitive text with placeholders such as `[SECRET_1]` or `[NAME_1]`. When an answer comes back,
the placeholders are put back.

| Where | What is replaced |
|---|---|
| Text sent to a remote model | Secrets, always. Personal details too, unless you set `redaction off`. |
| Results sent to agents, and the agent log | Secrets |
| Error messages and run notes that may hold a server's reply | Secrets, and your key wherever it appears |

- **Secrets** are:
  - keys and tokens from the common providers;
  - private key blocks and JWTs;
  - passwords in settings and in URLs;
  - card numbers (Luhn-checked) and IBANs (checksum-checked);
  - US social security and Canadian social insurance numbers;
  - private IP addresses and home folder paths.
- **Personal details** are emails, phone numbers, street addresses and postcodes, health words and medicines, and the
  names you list in `names`.

The limits:

- **It runs on patterns.** They catch the common shapes, not every way to write a secret or a person's details. A key
  in an unusual format, a name you haven't listed, and many non-English addresses go through. Check with
  `--preview` before a remote run.
- **Agents see personal details.** Results sent to agents have secrets replaced, but names, emails and addresses
  stay, since that is often what the agent needs.
- **Nothing is redacted on this computer.** The record keeps what you imported, pasted secrets included. The local
  model, your terminal and `export`'s zip all see the full text, and the zip is plain text.

## How releases are made

- Every release is built by GitHub Actions from a signed, verified tag on `main`. The workflow refuses to release
  unless:
  - the tag matches the package's version;
  - the commit is on `main`;
  - the tests pass;
  - the package check passes. It looks for no stray files, no model weights, no file over 1 MB, and no record data.
- npm gets the package through trusted publishing (OpenID Connect), so no npm token is stored anywhere, and npm
  records where each version was built. `npm audit signatures` checks that after you install.
- Each GitHub release carries the package tarball and its SHA-256 in `SHA256SUMS`, and those are the bytes npm serves.
- Every action in CI is pinned by commit, CI's token is read-only, and CI runs on macOS, Windows and Ubuntu with
  Node 24 and 26.
