<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo-mark-dark.svg">
  <img src="brand/logo-mark.svg" alt="" width="40" height="40">
</picture>

# Export

`skeinwise export` writes your record out as plain text you can read anywhere. Nothing goes to any server: the zip
stays on this computer until you move it.

## The zip

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
leaving: it can't be turned back into a record.

The app calls the same code: `writeExport(store, home, file)` in `src/sync/export.ts`, or `exportZip(store, home)` for
the bytes.
