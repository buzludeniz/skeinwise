# Skeinwise: the interface

The app is a local web page served by `skeinwise serve` on 127.0.0.1. Every screen below works by keyboard, and every
action on it is also an API call that the agent tools share.

## Capture bar

A thin bar along the top of the window, always visible:

- **Command bar** (⌥⌘K; Ctrl+Alt+K elsewhere)
- **Add files**
- **Live capture** toggle, with two status lines under it, for example "last saved 3 minutes ago" and "caught up 4
  chats from Claude Code"
- **Connect an agent**
- **Get an export**: step-by-step guides for ChatGPT, Claude and Gemini
- **Lock**
- **Settings** (⌘,)

## Onboarding

Four screens, shown once on first run.

### Welcome

One sentence on what Skeinwise does and one on privacy: everything stays in `~/.skeinwise`. A single **Start**
button and a link to the docs.

### Set up

Before anything is created, the screen lists exactly what will be made:

- the record folder `~/.skeinwise`, readable only by this user account;
- an empty record database;
- the local web server on 127.0.0.1;
- an MCP server entry for AI agents.

It also lists the agents it found on this computer (Claude Code, Codex, Cursor and others), each with a checkbox.
**Set it up** creates them, and each line ticks green as it finishes.

### Bring in

Every source found: Claude Code and Codex history folders, export files in Downloads (ChatGPT, Claude, Gemini),
Markdown folders and Obsidian vaults. Each one shows its size (entries and date range) and three choices: **Bring it
in**, **Leave it out** or **Decide later**. Note folders also get a **Whose words?** picker: mine, or another person's
name. **Bring in** imports the chosen sources. Original files are never changed.

### Watch it grow

The Map fills in live while the import and the first organiser run happen. A counter shows entries, threads and hubs.
When they finish, the screen offers a three-tip tour and a **Done** button that opens the main window.

## Rail

A narrow left column of icons with labels:

| Item | Opens |
|---|---|
| Search (⌘K) | The command bar |
| Map | The 3D view of the record |
| Browse | Folders, hubs, threads and notes in columns |
| Figures | Plain numbers about the record |
| Timeline | Activity over time |
| Portrait | What the record says about you |
| Lab | The table builder and Tides |
| Guide | How to read the Map |
| + Add | Add files, a note or a source |

Keys 1 to 8 switch views. The footer reads "Woven from N entries" and links to Figures.

## The Map

The main view: a dark canvas with a 3D point cloud shaped as a brain, with two lobes and a twisted, helical stem.

- Each point in the lobes is a note, a topic hub or a summary. The stem holds the original messages and files, wound
  in time order from the base up.
- Points are coloured by group: folder, source, speaker or hub, chosen in the legend.
- Drag to rotate, scroll to zoom, and double-click a point to open it. Hovering shows a card with the title, date and
  source.
- Top right: a search field that highlights matches, a **Fit** button, and view settings (point size, line density,
  labels on or off, auto-rotate).
- A legend at the foot ("Grouped by folder") lists the groups with counts and "+N more". Clicking a group isolates
  it.

## Guide

A side panel titled "How to read your map".

- **Points:** hubs (large and labelled), notes, summaries, originals in the stem, and clusters of related points.
- **Lines:** a *thread line* joins messages in one conversation; a *cross link* joins two entries about the same thing;
  a *note link* is a `[[link]]` you wrote; a *hub spoke* joins an entry to the hub it is filed under; a *time chain*
  joins entries in date order; a *label leader* runs from a label to its point.
- **Colour** is the group. **Size** is how many entries a point gathers.

## Hub panel

Opens when you click a hub. The header shows the hub's name, its kind ("Topic hub"), and a note that the organiser
wrote it, naming the engine and the run. Three sections follow: **In short**, **What you found** and **Open ends**.
Every bullet cites a dated quote of your own words, with a link to the entry it came from. Buttons: **Rename**,
**Merge into…**, **Not useful** (removes the hub) and **Regenerate**.

## Year rings

The Map seen from above as rings. Time runs from the centre outward, one ring per year, with months as slices. A "How
to read this" box explains position (when), colour (group), size (entries) and lines. The legend groups points by
month, plus Untagged and Other notes. The same menu switches back to the brain shape.

## Timeline

Charts of entries per week, split by source or speaker. Drag across a span to select it, and the matching points light
up in the Map, which stays visible above the chart. A date range picker has presets: last month, last year, all.

## Lab

A table builder. Pick any two properties for the axes (time, folder, source, speaker, tag, hub) and a third as a
filter, then one of six forms: table, heatmap, bars, stacked bars, lines or dots. Clicking a cell lists its entries.
Views can be saved.

A second tab, **Tides**, draws each topic's activity over time as a line, with a linear or log scale and a smoothing
slider.

## Browse

Three columns: folders and hubs on the left, threads and notes in the middle, the reader on the right. Sort by date or
name; filter by source, speaker and date. An **Inbox** folder holds entries not yet filed.

## Reader

Shows one entry or a whole thread.

- **Layer tabs:** Original, Cleaned, Expanded, Digest, Ideas. Only Original is your words. The other tabs carry a band
  naming the engine, model and run that wrote them.
- **Neighbours:** the entries before and after, and the most similar ones.
- **History:** each version with its editor (import, you, or an agent's name) and date. An entry an agent changed
  shows "Edited by an agent" at the top.
- **Buttons:** Edit, Not mine (for a thread), Copy link.

## Notes editor

**Edit** opens the note's Markdown file in a plain editor with a preview. Typing `[[` suggests note names. Saving writes
the file and adds a version. From the command bar, `note …` appends a line to today's daily note and `new note …`
starts a note with that title.

## Review

A queue of notes the organiser thinks may be out of date, each shown with the newer entries that suggest so and the
reason. For each: **Update** (the proposed change is shown as a diff first), **Still holds** or **Skip**. The rail shows
a count badge. Nothing changes without a click.

## Folders, runs and undo

- **Folders** lists folders with entry counts. Merging two keeps the old name as an alias, and the toast offers
  **Undo**.
- **Runs** lists every organiser run with its task, engine, model, time and counts. **Undo run** removes everything
  that run made.
- ⌘Z undoes the last change.

## Portrait

What the record says about you: the topics you return to most, your projects by time span, the people you mention,
and the first and latest date for each. Every line links to the entries behind it. **Check a claim** takes a sentence
(a line from a CV, say) and shows the entries that support or contradict it.

## Figures

Plain numbers: entries, threads, notes, hubs and sources; words by you and by assistants; the busiest months; and the
organiser's coverage (the share of entries tagged, filed and summarised).

## Command bar

One field (⌘K) for search, questions and commands.

- Typing lists matching entries as you type.
- A question ("when did I first mention X?") returns a view of your own entries and highlights them in the Map.
- Commands: `note …`, `new note …`, `open …`, `go to …`, `run tagging`, `undo`, `lock`, `theme …`.

## Settings

| Section | What it holds |
|---|---|
| Engine | No AI; a local model through an OpenAI-compatible URL (llama.cpp, Ollama); or a hosted endpoint. A **Test** button |
| Budget | A monthly token cap. At the cap, runs pause until the month resets |
| Privacy | Redaction before any outside model (names, emails, phone numbers, addresses, health words); exclusion rules by source, folder or pattern; the record folder's permissions and a disk-encryption check |
| Agents | Connected agents, **Copy config** for each, and **Copy a sample question** |
| Sync | An encrypted bundle to a folder you choose, a passphrase and recovery words |
| Proof of date | On or off |
| Backup | A zip of the record, on demand or daily |
| Appearance | Theme and palette |

## Themes

Six app themes: Dusk, Linen, Slate, Moss, Ink and Paper. Seven palettes for the points: Ember, Tide, Lichen, Heather,
Graphite, Saffron and Mono. The choice is remembered, and every theme keeps enough contrast for text.

## Lock and updates

**Lock** hides the window behind a passphrase screen and stops the agent tools until you unlock it. When a new release
is out, a thin banner says "Skeinwise X.Y is out" with **Update** (opens the release notes and the update command) and
**Later**.

---

## How this document was written

A small model running on this machine drafted it: Qwen3-4B (Q4_K_M GGUF from ggml-org on Hugging Face) under
llama.cpp's `llama-server`, temperature 0.4, thinking off, one section at a time from a short outline. The drafts were
then checked and corrected by hand. The corrections:

- **Padding cut.** Most sections closed with several sentences of generic praise ("designed to be intuitive"). They
  were removed.
- **Made-up facts removed.** The Figures draft invented a page of statistics. The hub panel draft invented quotes and
  dates. The update draft invented an automatic download and restart.
- **Wrong descriptions fixed.** The rail draft described Lab as a notes tool and Figures as diagrams. The browse draft
  had hubs grouping folders. The command bar draft had `lock` locking single entries. The review draft showed the diff
  before the person chose to update.
