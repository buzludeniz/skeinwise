# Bench

Measures Skeinwise against the performance budgets of the v1 plan (section 7.2) on seeded synthetic corpora of
50,000 and 150,000 entries, and exits 1 when any measure is over budget or fails to run.

```sh
node bench/run.ts            # 50k: a few minutes at full load on several cores
node bench/run.ts 150k       # on demand: much longer
node bench/run.ts 50k --entries 3000 --keep   # a quick check of the bench itself, 50k budgets
```

`pnpm bench` runs the same script. In CI (`.github/workflows/bench.yml`), every push runs
`pnpm bench 50k --entries 3000`, and the full 50k and 150k benches run only when the workflow is started by hand.

The corpus is invented: a heavy user's ChatGPT export (60 percent of the entries), Claude Code sessions in 20
projects (30 percent) and an Obsidian-style vault with daily notes, links, aliases and callouts (10 percent). The same
size and seed give the same files. Everything runs in one bench folder, `.skeinwise/bench/<size>` by default (git
ignores it): the corpus, the record (`SKEINWISE_HOME`) and a stand-in home folder (`HOME`), so no measure reads a real
history or record. The record's engine is `none`, so nothing goes to a model server. The folder is removed at the end
unless `--keep` is given, and the bench only ever clears a folder it made.

| Measure | How |
|---|---|
| Import (cold), peak memory | `import` of the three folders in a fresh process |
| `search` p95 | 20 searches, some with filters, one with no hits |
| `ask --engine none`, `similar` | the slowest of 3 questions and of 3 entries (a chat, a session, a note) |
| First `run all --engine none`, peak memory | stopped at twice its time budget, which counts as over |
| Organise 100 new entries | `import` of 100 new messages, then `run all --scope new` |
| `/api/brain` first load | bytes on the wire with gzip accepted, from `startServer` |
| MCP call p95, largest reply | 17 or more tool calls from an allowed agent: search, ask, timeline, list_hubs, read_hub |
| Live: write to searchable, idle memory | `skeinwise live` on the stand-in home; one message appended to a session, then searched for every 100 ms; resident memory once its background pass is over |
| `demo` build | the `demo` command into a new record |
| Web initial JS | the gzip size of the built page's module script and preloads (`pnpm build` first) |

Times are taken inside each measure's process, from the command's start to its end, without Node's own start-up. The
brain's frame rate needs a browser and a GPU, so the bench lists that budget without measuring it. The budgets are set
for an M1 with 16 GB; a busy machine runs slower, and the report's first line gives the load.

## Migrations

`node bench/migrations.ts [50k|150k] [--from <version>]` times the schema migrations on an old record: it imports the
same corpus, copies the record's content into a record at an older schema version (3 by default), and times each
migration step after it, `openDb` in one fresh process, and two processes opening the record at once (whether the second
waits out the upgrade or fails). Its folder is `.skeinwise/bench/migrations-<size>` by default. It has no budget: the
number to watch is any step past the 5 s busy timeout, which a second process opening the record meanwhile waits out
at most twice.
