# The organiser

Release 0.2.0 adds the organiser: the part of Skeinwise that reads your record and makes tags, folders, lines between
entries, concept hubs, layers and a review queue from it. It never changes what you wrote. Everything it makes belongs
to a run, and any run can be undone.

This page covers the engines, runs and the commands that come with them. Run `skeinwise help` for the full list.

## Quick start

On the demo record, without a model:

```bash
export SKEINWISE_HOME=~/skeinwise-demo
skeinwise demo
skeinwise run all --engine none
skeinwise hubs
skeinwise ask "what did I decide about sqlite"
skeinwise review
```

With a model server running on this computer (see below), leave out `--engine none`.

## Engines

An engine is what does the work in a run or a question. Pick one per command with `--engine`, or set the default with
`skeinwise config engine <name>`.

| Engine | What runs | What leaves this computer |
|---|---|---|
| `local` (the default) | A model server on this computer, at `http://127.0.0.1:8731/v1` unless you change it | Nothing |
| `remote` | A model server elsewhere, with a key from an environment variable | Redacted text, within a monthly budget |
| `none` (No-AI) | Word statistics: TF-IDF, cosine similarity, seeded k-means and sentence picking | Nothing |

With a model, the model does the work that needs judgement: hub summaries, topic and folder names, the staleness
review with its reasons and proposed updates, the Digest, Ideas and Expanded layers, and answers to questions. The
groups behind topics, folders and hubs, and every line between entries, come from word statistics with every engine.
No-AI does all of it from statistics and your own sentences, and writes no Expanded layer, because that needs new
words.

### A local model

The local engine talks to any server with the OpenAI chat completions API on 127.0.0.1, localhost or ::1. It refuses
an address on another computer: use the remote engine for that, so redaction and the budget apply.

Qwen3-4B, quantised to Q4_K_M, is a good size for this. Skeinwise never downloads a model. To start one you already
have with llama.cpp:

```bash
llama-server -m Qwen3-4B-Q4_K_M.gguf --port 8731 --jinja
```

Or point Skeinwise at Ollama:

```bash
skeinwise config localUrl http://127.0.0.1:11434/v1
skeinwise config localModel qwen3:4b
```

- **Which model:** `localModel` when it is set, otherwise the first model the server lists at `/models`. Before the
  first request of a run, Skeinwise asks the server for its models, and stops if the one set isn't there.
- **Thinking off:** every request asks the server to switch a thinking model's thinking off
  (`chat_template_kwargs: {"enable_thinking": false}`), which keeps answers short and in plain JSON.
- **No silent fallback:** when nothing answers at `localUrl`, the command stops with exit code 2, says how to start a
  server, and says that `--engine none` works without one. It never switches engines on its own.

### A remote model

```bash
skeinwise config remoteUrl https://api.example.com/v1
skeinwise config remoteModel <model name>
skeinwise config apiKeyEnv MY_MODEL_KEY
export MY_MODEL_KEY=...
skeinwise run hub --engine remote
```

- The key is read from the environment variable named in `apiKeyEnv` and is never written to `config.json`.
- The address must use https, unless it is on this computer.
- **Redaction** (on unless you set `redaction off`): before text goes out, emails, phone numbers, street addresses,
  health words and the names you list in `names` become placeholders such as `[NAME_1]`, and the placeholders in the
  answer are put back. The patterns are plain regular expressions: they catch the common shapes, not every way to
  write a person's details. Use `--preview` to see exactly what would be sent.
- **Budget:** `budget` is the number of tokens a remote model may use per calendar month (UTC), 1,000,000 unless you
  change it. A run that would go over it is refused before anything is sent; a run that reaches it part way stops and
  saves nothing. Local runs don't count against it.
- Skeinwise doesn't call a remote server before the first real request, since not every service lists its models.

### Model answers

Every request asks for one JSON object. Skeinwise checks each answer against what the task asked for: the right
fields, entry references that were in the request, sections that aren't empty. An answer that fails the check fails
the run, and nothing from it is saved. Each run records the tokens it used.

## Runs

```bash
skeinwise run <task> [--engine <name>] [--scope <scope>] [--preview] [--yes]
skeinwise run all
skeinwise runs
skeinwise undo <run>
```

| Task | What it makes |
|---|---|
| `tag` | Tags on entries, one run per schema (`--schema <name>` for one) |
| `file` | Folders, with every thread or loose note in one of them; what fits none goes to the Inbox |
| `link` | Cross links and note links |
| `hub` | Concept hubs, each with In short, What you found and Open ends |
| `layer` | The Cleaned, Expanded, Digest and Ideas layers of your entries |
| `review` | The review queue: notes of yours that later entries may have overtaken |

`run all` runs them in that order, each as its own run, and prints each run as it finishes. If one fails, the runs
before it are kept. Review reads hubs, so it needs a hub run first.

A run records its task, engine, model, scope, status, counts, tokens, and start and end times. `skeinwise runs`
lists them, newest first.

### Scopes

| Scope | Covers |
|---|---|
| `all` (the default) | Every entry in the record |
| `new` | Entries added or changed since that task's last run over `all` or `new` (for tags, of the same schema) |
| `source:<id>` | One source (`skeinwise sources` lists them) |
| `since:<YYYY-MM-DD>` | Entries on or after that date |

What you see is the newest run of each task: a run over `all` replaces the task's earlier runs, a run over `new` adds
to them, and a run over a source or a date replaces earlier runs over the same source or date. The runs it replaced
stay in `skeinwise runs`, and undoing the newer run brings their work back.

There is no background process: `--scope new` runs when you run it.

### Before a run

- **`--preview`** prints every request the run would send, with the text exactly as it would go (redacted, for a
  remote model), and an estimate of the tokens. It sends nothing and saves nothing.
- **`--yes`** is needed when a run with a model covers more than 500 entries. Without it, the run stops before
  sending anything and prints the number of requests and the token estimate.

### Undo

`skeinwise undo <run>` deletes everything the run made. Your entries and their versions are never touched. Undo
refuses when a later run or correction built on the run (a hub correction, say): undo that one first.

## The record's map

### Schemas and tags

A schema is a named list of tags. Three are built in:

- **Topics:** what entries are about, from groups of related entries.
- **Projects:** notes you link to from two or more other notes, and the entries that share their words.
- **Moods:** how you sound in your own words, from six tags with describing words.

Moods and your own schemas tag an entry when its words match a tag's name or its describing words. No-AI tags an
entry only when at least two of the words match; with a model, the model settles the entries that match by one word
only. With a model, it also names the topics.

```bash
skeinwise define-tag Kitchen bread sourdough rye loaf starter
skeinwise run tag --schema Kitchen
skeinwise tags --schema Kitchen
skeinwise define-tag Kitchen bread --remove
```

`define-tag` adds a tag to Moods or to a schema of your own (made on first use). Topics and Projects make their own
tags. A tag that a live run used can't be removed until that run is undone.

### Folders

Every thread, and every note outside a thread, goes into one folder. Folders come from the same groups as hubs and
topics and are named by their two strongest words, or by a model. `skeinwise folders` lists them.

### Hubs

One concept hub per group, with three sections built from your own sentences:

- **In short:** what the hub is about.
- **What you found:** dated quotes of what you learned or settled.
- **Open ends:** questions you asked that the hub leaves open.

Every item cites the entry it comes from. With a model, the model writes In short and Open ends and picks the
findings; No-AI picks your sentences by how central they are and by word cues.

```bash
skeinwise hubs
skeinwise hub 3 --limit 50
```

### Lines between entries

| Line | Joins | Made by |
|---|---|---|
| thread line | each entry to the next in its chat, session or note | the record's order |
| cross link | entries in different threads that read alike | the link task |
| note link | a note's `[[link]]` to the note it names | the link task |
| hub spoke | a hub to each entry it holds | the hub task |
| time chain | each entry to the next one in time | the record's order |

`skeinwise links` counts each kind; `skeinwise links <entry>` shows one entry's lines. Cross links come from word
statistics with every engine: they need shared words.

### Layers

| Layer | What it is | Made by |
|---|---|---|
| Original | The entry as you wrote it | You |
| Cleaned | The entry with spoken filler taken out | Word rules, with every engine |
| Expanded | The entry written out in full sentences | A model only |
| Digest | The entry in a few sentences | A model, or No-AI for entries of six sentences or more |
| Ideas | The ideas and plans in it | A model, or No-AI from sentences with plan words |

A model writes Digest, Ideas and Expanded for your own entries of 20 words to 3,000 characters. Layers sit beside the
entry and never replace it.

```bash
skeinwise layers 18
skeinwise layers 18 --layer digest
```

## Asking

```bash
skeinwise ask "when did I first mention sourdough"
skeinwise ask "what did I decide about sqlite"
skeinwise ask "what changed in my thinking on sqlite"
skeinwise ask "where did I write about acoustic panels"
skeinwise similar 385
```

- **"when did I first …"** lists the earliest entries that mention it.
- **"what did I decide about …"** lists the sentences where you settled it.
- **"what changed in my thinking on …"** lists the first mention, then every decision and change of course.
- **Anything else** is a ranked search, your own words first.

The first three are oldest first. With a model, a short answer comes first and names the entries it rests on; an
answer that cites an entry it wasn't shown fails. A question with a model is recorded as an ask run, for its tokens;
it saves nothing, so there is nothing to undo. With No-AI, you get the entries alone.

`similar <entry>` lists entries in other threads that read like it.

## Review

The review task checks each of your notes against your later entries that sit in one of its hubs or name it.

- **With a model,** the model reads them and says whether the note is out of date, why, and how it would read updated.
- **With No-AI,** a note is flagged when such an entry has a change cue ("decided", "changing my mind", "no longer",
  "instead", "switch to", "move to"), and the proposed note adds those sentences under "Updates".

```bash
skeinwise review
skeinwise review --resolve 8 update        # shows the change as a diff
skeinwise review --resolve 8 update --yes  # saves it as a new version of the note
skeinwise review --resolve 3 holds
skeinwise review --resolve 4 skip
```

- **update** shows the change first and saves it only with `--yes`, as a new version of the note. The text before
  stays in `skeinwise history`. A note in the record folder has its file rewritten too. If the note changed after the
  review, the update is refused.
- **holds** keeps the note as it is, and the entries behind the item won't flag it again.
- **skip** sets the item aside until the next review run.

## Your notes

Notes you write live as Markdown files in the record folder's `notes/`.

```bash
skeinwise note "Fed the starter at 18:00"     # adds a line to notes/daily/<today>.md
skeinwise new-note "Garden plan"              # starts notes/garden-plan.md
```

Edit them in any editor. Skeinwise reads the folder again before `note`, `new-note`, a run or a question, and a
changed file becomes a new version of the same entry, by you.

## Corrections

```bash
skeinwise merge-folders "Rust, lifetimes" 2
skeinwise rename-hub 3 Baking bread
skeinwise delete-hub 7
```

Each correction is a run of its own, by you, so `skeinwise undo <run>` takes it back. Undo them newest first: undo
refuses to take back a correction that a later one built on. A merged folder's old name stays as an alias.

Corrections apply to the run they correct. A new run of the same task over everything replaces that run, and the
corrections with it.

## Settings

`skeinwise config` lists the settings in `$SKEINWISE_HOME/config.json`, `config <key>` shows one, `config <key>
<value>` changes one, and `config <key> --unset` puts it back to its default.

| Key | Default | What it is |
|---|---|---|
| `engine` | `local` | The engine when a command doesn't name one: `local`, `remote` or `none` |
| `localUrl` | `http://127.0.0.1:8731/v1` | The local model server |
| `localModel` | (empty) | The model to ask for; empty means the first one the server lists |
| `remoteUrl` | (empty) | The remote model server |
| `remoteModel` | (empty) | The remote model |
| `apiKeyEnv` | (empty) | The name of the environment variable that holds the remote key |
| `budget` | `1000000` | Tokens a remote model may use per calendar month |
| `redaction` | `on` | Redact text before it goes to a remote model |
| `names` | (none) | Names to redact, comma-separated or a JSON list |
| `modelOptions` | `{}` | Extra fields for every model request, as JSON, for example `{"temperature": 0}` |

## Machine-readable output

Every command except `help` takes `--json`. Errors go to standard error. The exit code is 0 on success, 2 for a command that can't
be done as asked (a usage mistake, a model server that doesn't answer, a run over the budget), and 1 for anything
else.

## Not in this release

- **Folder scope** (`--scope folder:<name>`).
- **The sample test** before a tag run, and the comparison of a tag run with an earlier one.
- **`skeinwise model check`, `fetch` and `serve`:** start and check the local server yourself.
- **Live capture and background organising:** `--scope new` is there, but only runs when you run it.
- **The app, the MCP servers, the ledger, sync and export.**
- **Term vectors kept between runs:** each run computes them again (under a second on the demo record).
- **Model-judged links:** cross links come from statistics with every engine.
- **Undo for answers and settings:** review answers, `define-tag`, `exclude` and `not-mine` aren't runs, so
  `skeinwise undo` doesn't reach them. A review update keeps the old text in the note's history, `include` reverses
  `exclude`, and `not-mine --undo` reverses `not-mine`.
