# Export and encrypted sync

Two ways to get your record out of one computer. `skeinwise export` writes it as plain text you can read anywhere.
`skeinwise sync` keeps an encrypted copy in a folder you choose, so another computer can become a copy of it.
Nothing goes to any server: the folder can be one a cloud drive keeps in step, a USB stick or a network share.

## Export

```
skeinwise export [<file>] [--force]
```

Writes a zip, `skeinwise-export-YYYY-MM-DD.zip` in the current folder unless you name another file. It never replaces
a file unless you add `--force`, and it is owner-only (mode 0600), because it is your record in plain text. Inside
one folder named after the day:

| Path | What |
|---|---|
| `chats/<source>/<date>-<title>-<thread>.md` | One file per chat. Front matter says where it came from; each message is a `## who · date time · entry N` heading with the text under it. |
| `entries/<source>/<date>-<title>-<entry>.md` | One file per entry that isn't part of a chat (an imported note or file). |
| `notes/` | The notes in your record folder, byte for byte. They aren't repeated under `entries/`. |
| `tags.json`, `folders.json`, `hubs.json` | What the organiser made as it stands now. Entries are named by their number, the one in the Markdown headings. |
| `runs.json` | Every organiser run, oldest first. |
| `record.json` | When it was exported, the counts and the sources. |
| `README.md` | What is where. |

Entries from a source you set aside or a chat marked "not mine" are still in the export, marked in their front
matter: they are still yours. Only the newest version of each entry is written. An export is for reading and for
leaving: it can't be turned back into a record. A sync bundle can.

The app calls the same code: `writeExport(store, home, file)` in `src/sync/export.ts`, or `exportZip(store, home)` for
the bytes.

## Sync

```
skeinwise sync init <folder> [--passphrase-file <file>]
skeinwise sync push [--force]
skeinwise sync join <folder> [--passphrase-file <file>]
skeinwise sync restore <folder> [--phrase-file <file>]
skeinwise sync status
```

1. **init** on the computer that has your record. It asks for a passphrase twice (typing is hidden), makes a sync
   key, writes the first bundle and shows a 24-word **recovery phrase once**. Write the phrase down on paper.
2. **push** whenever you want the folder to hold your record as it is now. It writes a fresh bundle; no passphrase
   is asked for.
3. **join** on another computer, with an empty record and the passphrase. That record becomes a copy of the newest
   bundle. **restore** is the same with the recovery phrase, for when the passphrase is lost.
4. **status** says which push this computer last wrote or joined from, and whether another computer pushed since.

A passphrase or phrase is never given as a flag's value, which would stay in your shell history. It comes from the
hidden prompt or from a file (`--passphrase-file`, `--phrase-file`); one final line break in the file is ignored.

### What is in the folder

| File | What |
|---|---|
| `skeinwise.keys` | The sync key, stored twice: once locked with your passphrase, once with your recovery phrase. JSON. |
| `skeinwise.bundle` | Your whole record, zipped and encrypted with the sync key. Replaced by every push. |

Both are written whole or not at all (written beside, then renamed), so a cloud drive never picks up half a bundle.

### What is in a bundle

The whole record, not a difference: any one bundle rebuilds it.

- `record.db`: a consistent snapshot of the database, so every version of every entry, every organiser run and every
  correction you made.
- `notes/`: the notes folder, file for file.
- `config.json`, `app.json` and `ledger.jsonl`, when this computer has them.
- `bundle.json`: when it was written, how many entries, the schema version, and where this computer's notes folder
  is (a join points the notes source at its own).

Not in it: downloaded models (`models/`), the app's backups (`backups/`) and `sync.json`.

### The key scheme

- **The sync key** is 256 random bits. It encrypts every bundle with AES-256-GCM, with a fresh random 96-bit IV for
  each push.
- **The bundle file** is the bytes `SKWSYNC`, a format byte, the header's length, a JSON header, the ciphertext and
  the 16-byte tag. The header holds the sync's id, the push number, a random id for the computer that wrote it, the
  time and the IV. It is not secret, but it is part of what the tag checks, so changing one byte anywhere in the file
  makes it fail.
- **The key file** holds the sync key twice. Each copy is encrypted with AES-256-GCM under a key that scrypt derives
  from a secret, with a random 16-byte salt for each copy: one from your passphrase, one from your recovery phrase.
  The scrypt settings are N = 2^17, r = 8, p = 1 (128 MB and about a quarter of a second on a laptop, for each try).
  Each copy's associated data names the sync's id and which secret it is for, so a copy can't be moved into another
  key file or the other slot.
- **The passphrase** has at least 12 characters. It is Unicode-normalised (NFC), so the same letters typed on
  another computer give the same key.
- **The recovery phrase** is 24 words picked at random from a fixed list of 256 (`src/sync/words.ts`): 192 random
  bits. No two words share their first four letters. When typed back, case, numbering and line breaks don't matter.
- **Neither secret is stored anywhere.** Skeinwise can't tell you either one, and nobody can open the bundle without
  one of them or the key.
- **This computer keeps the sync key** in `sync.json` in the record folder (owner-only, like `record.db`), so `push`
  needs no passphrase. Anyone who can read your record folder can already read your record. With that key they can
  also read and write the bundles, so treat the record folder as you would the record.

The key file sits in the folder, so anyone who gets the folder can try passphrases against it, each try costing a
quarter of a second of a laptop's time. A long passphrase (four or five unrelated words) is what keeps it closed.
The recovery phrase is beyond guessing.

### join and restore go into an empty record only

A join makes a record a copy of the bundle's. Skeinwise can't merge two records yet, so **join refuses a record that
isn't empty**, before it asks for anything, and writes nothing. Empty means:

- nothing in the database but what a new record starts with (the built-in schemas and Moods tags);
- no files in the notes folder;
- no `ledger.jsonl` and no `sync.json`.

`config.json` and `app.json` don't count: a join keeps this computer's own and brings over only those it lacks.

To join from a computer that already has a record, use a new record folder
(`SKEINWISE_HOME=~/skeinwise-joined skeinwise sync join <folder>`), or move the old one aside first.

### Before anything is written

A join does all of this first, and stops with nothing written if any step fails:

1. reads the key file and opens the sync key with your secret (a wrong secret: "does not open the sync");
2. checks and decrypts the bundle (a changed or cut-short bundle: "fails its check");
3. unpacks it, refusing any file it doesn't expect or any path that leads outside the notes folder;
4. opens the snapshot in memory and refuses one written by a newer Skeinwise.

Then it copies the rows in one transaction, puts the notes in place, and writes `sync.json` last.

### Two computers pushing

Each push replaces the bundle. Push numbers go up by one each time, from whichever computer pushes. If another
computer pushed after this one last pushed or joined, **push refuses**, because replacing that bundle would leave
the other computer's newer work in no bundle (it stays on that computer). `push --force` replaces it anyway. Until
merging exists, push from one computer and join from the others, or push from each in turn and join again before
working there.

### If you lose the passphrase and the recovery phrase

- **A computer that still syncs** has the key in its `sync.json`. Its record is whole and its pushes still work.
  To get a new passphrase and phrase, start a new sync from it: move `sync.json` aside, then
  `skeinwise sync init <new folder>`. Other computers join the new folder.
- **No computer that still syncs:** the bundle can't be opened, by you or by anyone. There is no back door and no
  reset. Your record is still wherever its record folder is; `skeinwise export` gives a plain-text copy of it any time.

## Not built yet

- Merging two records, so join could go into a record that isn't empty and push wouldn't have to replace.
- Changing the passphrase or the phrase without starting a new sync.
- Streaming large records: a bundle is built in memory, the whole record at once.
- Old bundles: a cloud drive's version history may keep earlier bundles, and they open with the same key.
