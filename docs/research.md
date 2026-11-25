# Skeinwise: research

## The problem

People now do much of their thinking in conversations with AI assistants: in a browser (ChatGPT, Claude, Gemini) and
in the terminal (Claude Code, Codex). Next to that sit years of notes in Markdown folders. All of it is personal,
dated and full of decisions, but it is spread across export archives and hidden history folders that no single tool
reads together. Notes apps expect you to do the filing yourself. Chat apps forget everything outside the current
conversation.

What people want from that pile:

1. **One record.** Every conversation and note in one place, each entry dated and attributed (who said it: you, an
   assistant, or someone else).
2. **Organised for them.** Tags, folders, links and summaries made by machine, which they can trust because the
   originals are never touched and every change can be traced and undone.
3. **Answers from their own words.** "When did I first think about X?", "What did I decide about Y?", answered by
   pointing at their own dated entries rather than by a fresh guess.
4. **Memory for their agents.** The coding and chat agents they already use can search and cite the record.
5. **Privacy.** It runs locally, works without a cloud model, and redacts personal details before anything leaves
   the machine.

## The landscape

- **Notes tools** (Obsidian, Logseq and other Markdown vault apps) are local and portable, but the user does the
  organising, and none of them read AI chat exports.
- **Hosted "AI memory" services** remember facts across chats, but they keep that memory on someone else's server and
  tie it to one assistant.
- **Local AI search tools** index files and answer questions over them, but they treat the files as documents, not as
  a dated record of what the user said, and they rarely keep provenance for what the model added.
- **Memory servers for agents** (MCP servers backed by a vector store or a Markdown folder) give an agent a place to
  write notes, but they don't import the user's history.

The gap Skeinwise fills: a local, dated, append-only record built from all of these sources; an organiser that works
with no model, a small local model, or a hosted one, and labels everything it adds; and the same record offered to
the user (a 3D map, a timeline, plain-word questions) and to their agents (MCP).

## Export and history formats

The importers are written against these shapes. Each importer accepts missing fields and skips what it can't read,
so a format change degrades the import rather than breaking it.

### ChatGPT (account data export)

A zip with `conversations.json`: an array of conversations.

- Conversation: `id` or `conversation_id`, `title`, `create_time` and `update_time` (Unix seconds, fractional),
  `mapping`, `current_node`.
- `mapping` is a tree keyed by node id. A node has `message`, `parent` and `children`. Edits and regenerations make
  branches; the active branch is the path from `current_node` up through `parent`.
- Message: `id`, `author.role` (`user`, `assistant`, `system`, `tool`), `create_time`, `content.content_type`
  (`text`, `code`, `multimodal_text` and others), and `content.parts` (strings, or objects for images and files).

### Claude (account data export)

A zip with `conversations.json`, plus `projects.json` and `users.json`.

- Conversation: `uuid`, `name`, `created_at` and `updated_at` (ISO 8601), `chat_messages`.
- Message: `uuid`, `sender` (`human` or `assistant`), `created_at`, `text`, and `content` (blocks such as
  `{ type: "text", text }`), with `attachments` and `files`.

### Gemini (Google Takeout, "My Activity", Gemini Apps)

`MyActivity.json`: an array of activity items, one per prompt.

- Item: `header`, `title` (the prompt, after a "Prompted" prefix), `time` (ISO 8601), and `safeHtmlItem` (the
  response as HTML).
- Takeout doesn't group the items into conversations. Skeinwise groups items into threads when they fall within 30
  minutes of each other.

### Claude Code (local history)

`~/.claude/projects/<folder-slug>/<session-id>.jsonl`, one JSON object per line.

- Line: `type` (`user`, `assistant`, `summary`, `system` and others), `uuid`, `parentUuid`, `sessionId`,
  `timestamp`, `cwd`, and `message` (`role` plus `content`, either a string or blocks: `text`, `tool_use`,
  `tool_result`, `thinking`).
- Skeinwise keeps the text blocks only. Tool calls and results are noise for a personal record.

### Codex CLI (local history)

`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`.

- The first line is `{ type: "session_meta", payload: { id, timestamp, cwd, … } }`.
- Message lines are `{ timestamp, type: "response_item", payload: { type: "message", role, content } }`, where
  content blocks are `input_text` (user) or `output_text` (assistant). Other lines (`event_msg`, tool calls,
  reasoning) are skipped.

### Markdown folders and Obsidian vaults

- `.md` files, with optional YAML front matter (`title`, `tags`, `created`, `date`), `[[wiki links]]` and `#tags`.
- The date comes from front matter if present, else from a date in the file name, else from the file's modified
  time.
- Plain `.txt` files are read as notes too.

## What this means for the design

- **Entries, not documents.** The unit is one message or one note, with a speaker and a date, so the record can
  answer "when" and "who" questions.
- **Content hashes.** Exports overlap: the same conversation arrives again and again, sometimes edited. Hashing each
  entry's text makes re-import idempotent, and a changed text becomes a new version instead of a duplicate.
- **Speaker matters.** Your words are the record. An assistant's words are context. Search, summaries and the brain
  view weight them differently, and a conversation marked "not mine" leaves them entirely.
- **Provenance on everything derived.** Each tag, folder, link and summary records the run that made it, so a bad
  run can be undone in one step.
