# The ledger and proof of date

Skeinwise keeps a ledger of your record: `ledger.jsonl` in the record folder, one line for each import, each edit
and each finished run. Every line carries the SHA-256 of the line before it, so changing, adding or removing a line
breaks the chain from there on, and `skeinwise ledger verify` names the line where it breaks.

A chain on your own disk shows that the ledger wasn't changed piece by piece. It can't show when the ledger was
written: anyone willing to rewrite every line could write a new one. For that, Skeinwise can stamp the ledger's
latest line with [OpenTimestamps](https://opentimestamps.org), which puts a hash of it into the Bitcoin blockchain.
A stamp proves the line, and every line and every text before it, existed by a date nobody can move.

Stamping is optional, and it is the only part of Skeinwise that contacts a server for the ledger. It asks you first.

## What is recorded

Lines hold ids, counts and hashes. They never hold your words, titles, file names or where an import came from.
Three kinds, taken from a ledger of the demo record:

```json
{"n":1,"prev":null,"at":"2026-11-20T18:00:00.000Z","kind":"import","source":1,"sourceKind":"chatgpt","versions":[1,180],"count":180,"digest":"eedd5daf2bb67cb1ffd563bda917d96ccf2e51080f517b4b7cf58add79127514"}
{"n":5,"prev":"0d2fcb99183f7f60894fc625f4a6e73e4d7abb5b8baf98b36718f3986328a57a","at":"2026-11-21T09:00:00.000Z","kind":"edit","entry":421,"version":2,"versionId":423,"editor":"you","hash":"d8d7e6af05fd1c46a02f8de35778ba947d068ff4eb8bc365fb57d2806a5af2ad"}
{"n":6,"prev":"9a8088b03b517f0826155e27b13209874b1492554ea1ec52b9d5c3d9d6222a5a","at":"2026-11-21T09:00:00.000Z","kind":"run","run":1,"task":"tag","engine":"none","model":null,"scope":"all","schema":1,"status":"done","counts":{"entries":422,"tagged":422,"coverage":100,"tags":8,"added":422,"removed":0,"unchanged":0},"startedAt":"2026-11-21T09:00:00.000Z","finishedAt":"2026-11-21T09:00:00.000Z"}
```

- Every line has its number `n`, `prev` (the SHA-256 of the line before, as written and without its newline; null on
  line 1) and `at`, when the ledger wrote it.
- An **import** line covers the versions one import brought in from one source: new entries and changed ones. It
  records the source's id and kind, the first and last version ids, how many there are, and `digest`: the SHA-256
  over `<version id> <entry id> <version> <content hash>` and a newline for each of them, in id order.
- An **edit** line covers one version written in Skeinwise rather than imported: your notes and edits, under
  `"editor":"you"`, and an agent's, under its name. `hash` is the version's content hash, the SHA-256 of its text.
- A **run** line records a finished run (done or failed) with its task, engine, model, scope, counts and times. A
  run that is undone later gets a second line. A run's message, its details and anything sent to a model are not
  recorded.

The ledger records what it found when it caught up, not when you wrote something: `at` is the time of the catch-up.
It catches up after each import, run and capture, and before each stamp. Nothing else writes it.

## Checking the ledger

```bash
skeinwise ledger verify
```

It checks three things and writes nothing:

- **The chain**, from line 1: each line is whole, says the right line number, and carries the hash of the line before.
  The first line that fails is named, with what is wrong with it.
- **The record against the ledger**: each import and edit line's versions are still in `record.db` with the same
  content hashes, their text still hashes to them, and no version has turned up under a number the ledger passed over.
- **The stamps** in `ledger-proofs/`: each one is a readable proof of the line it names, and is either waiting at the
  calendars or in a Bitcoin block.

It also says what the record holds that the ledger hasn't taken in yet. It exits 1 when anything fails. `--json`
gives the same as data.

You don't need Skeinwise to check the chain. Line 57's hash is `printf '%s' "$(sed -n '57p' ledger.jsonl)" | shasum
-a 256`, and line 58's `prev` must be that hash.

What the chain alone can't catch: a change to the last line (no line after it carries its hash yet), and a ledger
rewritten whole, with every hash worked out again. A stamp catches both for every line up to the stamped one.

## Dating the ledger

```bash
skeinwise ledger stamp
skeinwise ledger collect      # a few hours later
```

`stamp` catches the ledger up, then dates its last line. It sends one hash to four OpenTimestamps calendar servers
(`a.pool.opentimestamps.org`, `b.pool.opentimestamps.org`, `a.pool.eternitywall.com` and `ots.btc.catallaxy.com`):
the SHA-256 of the line's hash followed by 16 random bytes. The servers learn nothing about your record from it, not
even the line's hash. It says what it will send and asks first; `--yes` sends without asking. The proof goes to
`ledger-proofs/line-N.ots`. One calendar answering is enough; the ones that didn't are named. Stamping a line that is
stamped already sends nothing.

The calendars gather the hashes they receive and put one hash of them all into a Bitcoin transaction, which takes a
few hours. `collect` then asks the calendars each waiting stamp names whether it is in a block yet, and stores the
finished proof. It asks first too, and only asks calendars on `calendar.opentimestamps.org`,
`calendar.eternitywall.com` and `calendar.catallaxy.com`, over https. A stamp that is still waiting is not an error;
try again later.

`verify` then shows the block's height and its merkle root. A block explorer shows the same root for that height,
with the bytes in the same order.

The proof files are standard OpenTimestamps proofs. To check one without Skeinwise, write the line exactly as it is
in the ledger, without a newline, and give it to the OpenTimestamps client, which checks the block against a Bitcoin
node:

```bash
printf '%s' "$(sed -n '57p' ledger.jsonl)" > line-57.txt
ots verify -f line-57.txt ledger-proofs/line-57.ots
```

Stamp when it matters: before you share something, before a deadline, or once a week. Each stamp covers everything
before it, so there is no need to stamp every line.

## What a stamp proves, and what it doesn't

A finished stamp of line N proves that line N existed when its Bitcoin block was mined. Block times are only accurate
to a couple of hours, so read it as "by that day". Through the chain it proves the same of every line before N, and
through their hashes, of the text of every version those lines record. Show someone an entry's text, the ledger up to
line N and the proof, and they can check for themselves that the text existed by that date.

It doesn't prove:

- **Who wrote it.** A stamp dates a hash. It says nothing about the person who made the text.
- **When you wrote it.** It shows the text existed by the stamp, not how long before. An import of an old export is
  dated when you imported it; the dates inside the export are the export's own claims.
- **Anything after the stamp.** Lines after the last stamped one, including a changed last line, are covered only by
  the chain until the next stamp.
- **That this is your only ledger.** Nothing stops someone keeping a second record and ledger and stamping both.
- **Anything without the text.** The ledger holds hashes. To show an entry matches, you show its text.

What showing reveals: to prove one version from an import line, the other person needs the whole batch's version
ids, entry ids and content hashes to work out the `digest` again. That shows how many versions the import held and
their hashes, not their text. A hash of a short or guessable text, like "yes", can be confirmed by guessing.

## When something is wrong

- **"ends in the middle of line N"**: something stopped while the ledger was being written. The cut-off line was never
  finished, and no line chains onto it. Keep a copy of the ledger, remove that last partial line, and the next catch-up
  writes it again.
- **"record.db was replaced or rolled back"**: the record is older than the ledger, as after restoring a backup. Move
  `ledger.jsonl` and `ledger-proofs/` aside and keep them (their stamps still prove what they proved); a new ledger
  starts at the next catch-up. Or put the newer `record.db` back.
- **"The ledger is busy"**: another Skeinwise is writing it. If none is running, delete `ledger.lock` in the record
  folder and try again.
- **A broken chain or a record that doesn't match**: `verify` names the first line that fails. Lines before it still
  check, and so do stamps of them. Stamping refuses a ledger whose chain is broken.
