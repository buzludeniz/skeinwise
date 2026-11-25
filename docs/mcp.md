# Skeinwise: agent memory (MCP)

Skeinwise has two MCP servers that give an AI agent your record as its memory. Both run on this computer, over stdio:
the agent starts one itself, from its config.

- **The memory server** (`skeinwise mcp`) searches, reads and writes the record.
- **The window server** (`skeinwise mcp --window`) moves the app's view while you watch.

What a tool returns goes into the agent's conversation, and from there to whatever model the agent runs on. Allow
only agents you would show those entries to.

## Set it up

1. Put `skeinwise` on your path. In the clone, after `pnpm install` and `pnpm build`, run `pnpm link --global`;
   `skeinwise version` then works in any terminal.
2. Add the server to your agent with one of the snippets below. Add the window server too if you'd like the agent to
   point at things in the app.
3. Ask the agent something about your notes. Its first call is refused, and the refusal names the agent as its client
   reports itself:

   ```text
   Skeinwise hasn't allowed "claude-code" to read or write your record yet. To allow it, run: skeinwise mcp allow claude-code
   ```

   Run that command and ask again. `skeinwise mcp agents` lists every agent that has asked.

### Claude Code

For every project:

```bash
claude mcp add --scope user skeinwise -- skeinwise mcp
claude mcp add --scope user skeinwise-window -- skeinwise mcp --window
```

For one project, in `.mcp.json` at its root:

```json
{
  "mcpServers": {
    "skeinwise": { "command": "skeinwise", "args": ["mcp"] },
    "skeinwise-window": { "command": "skeinwise", "args": ["mcp", "--window"] }
  }
}
```

### Claude desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or
`%APPDATA%\Claude\claude_desktop_config.json` on Windows, then restart Claude. The desktop app doesn't see your shell's
path, so give the full path that `which skeinwise` prints:

```json
{
  "mcpServers": {
    "skeinwise": { "command": "/full/path/to/skeinwise", "args": ["mcp"] },
    "skeinwise-window": { "command": "/full/path/to/skeinwise", "args": ["mcp", "--window"] }
  }
}
```

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.skeinwise]
command = "skeinwise"
args = ["mcp"]

[mcp_servers.skeinwise-window]
command = "skeinwise"
args = ["mcp", "--window"]
```

Or from a terminal: `codex mcp add skeinwise -- skeinwise mcp`.

### Cursor

In `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one:

```json
{
  "mcpServers": {
    "skeinwise": { "command": "skeinwise", "args": ["mcp"] },
    "skeinwise-window": { "command": "skeinwise", "args": ["mcp", "--window"] }
  }
}
```

### Any other client

Any MCP client that starts a stdio server works: the command is `skeinwise`, the arguments `mcp` (or `mcp --window`).

### Another record folder, or no `skeinwise` on the path

The servers use `~/.skeinwise`, or the folder in `SKEINWISE_HOME`. To point an agent at another record, set it in the
config's `env`. Without `pnpm link`, run the built CLI with node, using full paths:

```json
{
  "mcpServers": {
    "skeinwise": {
      "command": "/full/path/to/node",
      "args": ["/full/path/to/skeinwise/dist/src/cli.js", "mcp"],
      "env": { "SKEINWISE_HOME": "/full/path/to/a/record" }
    }
  }
}
```

The window server talks to the app on port 7319. If `skeinwise serve` runs on another port, add `--port <n>` to the
window server's arguments.

## Allowing agents, and the lock

| Command | What it does |
|---|---|
| `skeinwise mcp allow <agent>` | Lets the agent use both servers. Names match whatever their case. |
| `skeinwise mcp revoke <agent>` | Takes the allowance back; the agent's next call is refused. |
| `skeinwise mcp agents` | Lists the allowed agents, the ones that asked, and whether the tools are locked. |
| `skeinwise mcp lock` | Stops every tool of every agent, from its next call, until you unlock. |
| `skeinwise mcp unlock` | Lets allowed agents use their tools again. |

They keep `agents.json` in the record folder (readable by you only). Every tool call reads it, so a change takes
effect on the agent's next call, with no restart:

```json
{
  "locked": false,
  "allowed": { "claude-code": "2026-11-25T09:00:00.000Z" },
  "asked": { "cursor": "2026-11-25T09:05:00.000Z" }
}
```

The agent's name is the one its client sends: `clientInfo.name` in the `initialize` handshake, or in each request's
`_meta` on protocol 2026-07-28. It is a consent check, not a password: any program on this computer can start
`skeinwise mcp` and give any name. It stops an agent you configured from reading your record before you say so, and it
puts a name on every write. A client that gives no name is refused.

## The memory tools

Reads see what the record shows: included sources, and conversations not marked "not mine". Dates are ISO times; a
`from` or `to` may be a bare day (`2026-11-25`), and a `to` day reaches to its end.

| Tool | What it does | Arguments |
|---|---|---|
| `search` | Full-text search, best matches first, your own words weighted above assistants'. Ids, dates, a snippet each. | `query`; `limit` (10, up to 50), `speaker`, `source`, `from`, `to` |
| `ask` | Answers a question from your entries with dated quotes (no model; the agent writes the answer). | `question`; `limit` (10, up to 30) |
| `read_entry` | One entry's whole text, each version's editor and date, and its hubs. | `entry_id` |
| `read_thread` | A conversation's messages in order, a page at a time. | `thread_id`; `offset`, `limit` (50, up to 200) |
| `timeline` | Entries in date order with an excerpt each. | `from`, `to`, `speaker`, `source`, `newest_first`, `offset`, `limit` (20, up to 100) |
| `list_hubs` | The organiser's concept hubs with their size and short summary. | none |
| `read_hub` | One hub: the organiser's reading of your entries, each point citing a dated entry. | `hub_id` |
| `write_note` | Starts a note of the agent's own, or gives new text to one it started. | `title`, `body` |
| `append_daily_note` | Adds a line to today's daily note. | `text` |
| `tag_entries` | Tags entries, as one run. | `entry_ids`, `tag`; `schema` |
| `not_mine` | Marks a conversation as someone else's words. | `thread_id` |
| `undo_run` | Takes back a run the agent made. | `run_id` |

A refusal or a mistake (an unknown id, a missing argument, the lock) comes back as the tool's result, marked as an
error, so the agent can tell you or try again.

## What agents write

Every write keeps the record's rule: nothing is overwritten, each change is a new version with its editor and date.

- **`write_note`** writes `notes/<title>.md` with `agent: <name>` in its front matter, and the agent is the entry's
  speaker, so the organiser doesn't read the note as your words. A later call with the same title saves a new version.
  It refuses your notes, another agent's, and a note you changed after the agent wrote it.
- **`append_daily_note`** adds `- <agent>: <text>` to `notes/daily/<day>.md`. The note stays yours; the save is a version
  by the agent.
- **`tag_entries`** makes one run with the engine `agent` and the agent's name as the model. Its tags go in the "Agent
  tags" schema, made on first use, unless the agent names another one (Moods or one of yours). Topics and Projects
  belong to the organiser and are refused. The organiser's own tag runs leave an agent's run in place.
  `skeinwise runs` lists it, and `skeinwise undo <run>` or the agent's `undo_run` takes it back.
- **`undo_run`** takes back only the calling agent's own runs.
- **`not_mine`** leaves the conversation out of search, questions and the organiser. Bring it back with
  `skeinwise not-mine <thread> --undo`.

`skeinwise history <entry>` shows who made each version.

## The window server

`skeinwise mcp --window` serves five tools. Each one checks its ids against the record, then sends one message to the
running app:

```text
POST http://127.0.0.1:<port>/api/window
content-type: application/json
x-skeinwise-token: <the 64 hex characters in <record folder>/token>
```

The body is one of these, with `agent` set to the allowed agent's name:

| Tool | Body |
|---|---|
| `show_in_brain` | `{"type": "show_in_brain", "entryIds": [12, 40], "hubIds": [3], "agent": "claude-code"}`: switch to the brain and frame these, lit up |
| `open_entry` | `{"type": "open_entry", "entryId": 12, "agent": "claude-code"}`: open the entry in the reader |
| `open_hub` | `{"type": "open_hub", "hubId": 3, "agent": "claude-code"}`: open the hub's panel |
| `set_layout` | `{"type": "set_layout", "layout": "rings", "grouping": "speaker", "agent": "claude-code"}`: `layout` is `brain`, `rings` or `clusters`; `grouping`, when given, is `project`, `folder`, `source` or `speaker` |
| `highlight` | `{"type": "highlight", "query": "sourdough", "entryIds": [12], "agent": "claude-code"}`: light these up and dim the rest, without moving the view; with neither `query` nor `entryIds`, clear it |

`src/mcp/window.ts` defines these shapes (`WindowMessage`, `WindowRequest`).

The app answers 2xx when it has moved, optionally with `{"message": "…"}`, which the tool passes on. Anything else is
an error for the agent:

| The app answers | The agent is told |
|---|---|
| nothing (not running, wrong port) | the app isn't answering on that port: start it with `skeinwise serve`, or give `--port` |
| 423 | Skeinwise is locked |
| 401 | the app refused the token: it serves another record folder |
| 404 or 405 | the app can't move its view yet |
| another status | the status and the app's `error` text |

There is no token until the app has run once.

## Protocol

Both servers speak MCP's stdio transport, one JSON-RPC message per line. They accept protocol 2026-07-28, where each
request carries its version and client in `_meta` and `server/discover` describes the server, and the earlier versions
2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05, which open with `initialize`. Only tools are offered. Standard
output carries only protocol messages; the servers log to standard error.
