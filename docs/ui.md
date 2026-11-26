<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo-mark-dark.svg">
  <img src="brand/logo-mark.svg" alt="" width="40" height="40">
</picture>

# Skeinwise: the interface

The app is a local web page served by `skeinwise serve` on 127.0.0.1. Every screen works by keyboard, and every
action on it is also an API call that the agent servers share.

## Look

- **A dark canvas first.** The default theme is dark, because the brain view is points of light on a dark ground.
  Panels sit on top of the canvas as cards with soft edges, and text uses one sans-serif family in three sizes.
- **Icons** come from [Lucide](https://lucide.dev) (ISC licence). Skeinwise draws its own logo: a wound skein whose
  loose end becomes a thread.
- **Colours are ours** and live as CSS variables per theme (see Themes). The default theme, Dusk:

  | Token | Value | Used for |
  |---|---|---|
  | `--ground` | `#0f1219` | The canvas and the window |
  | `--panel` | `#181c26` | Rail, cards, menus |
  | `--line` | `#2a3040` | Borders and dividers |
  | `--ink` | `#e9e4d8` | Body text |
  | `--ink-soft` | `#959aa8` | Secondary text |
  | `--accent` | `#e3a857` | Focus rings, the selected item, live status |

- **Sizes:** the rail is 76 px wide; panels open at 380 px from the right; body text is 14 px, headings 18 px, labels
  12 px; corners are 10 px.

## App menu

The Skeinwise mark at the top of the rail opens the app menu (⌥⌘K opens the command bar from anywhere, even with the
menu closed). Its items, in order:

1. **Open Skeinwise**: brings the window forward.
2. **Command bar** ⌥⌘K
3. **Add files…**: a file picker for exports, notes and folders.
4. **Live capture**: a switch. Under it, two status lines that change as things happen, for example "saved 2 minutes
   ago" and "caught up 3 chats from Claude Code · organised 41 new entries".
5. **Connect ▸**: each agent found on this computer, with Connect or Connected.
6. **Get an export ▸**: ChatGPT, Claude, Gemini. Each opens our step-by-step guide for requesting that export. With
   Live capture on, a file that lands in Downloads is proposed to pending, and you review it in the terminal with
   `skeinwise live pending`.
7. **Lock**
8. **Settings** ⌘,
9. **Quit**: stops the local server.

A desktop wrapper that puts the same menu in the system menu bar is on the list for later.

## First run

### Set up

One screen, shown before anything is created. It lists what will be made:

- the `skeinwise` command;
- an empty record in `~/.skeinwise`, readable only by this user account;
- two local servers for AI agents: the **memory server** (search, ask, read and write) and the **window server**
  (moves the app's view);
- the local model: the one already found on this computer, or the one Skeinwise suggests, with its size and where it
  will be saved.

It also names the agents it found (Claude Code, Codex, Cursor and others), each with a checkbox. **Set it up** makes
everything, and each line turns green as it finishes.

### Bring in

Every source found, as cards: Claude Code and Codex history, export files in Downloads (ChatGPT, Claude, Gemini),
note folders and Obsidian vaults. Each card shows how much it holds (entries and date range) and three buttons:
**Bring it in**, **Keep it out** and **Later**. A note folder also asks **Whose words?**: mine, or a person's name.
Original files are never changed.

### Watch it grow

The brain fills in point by point while the import and the first organising pass run, with a counter of entries,
threads and hubs. When they finish, a three-tip tour and **Done**.

## Rail

A narrow column on the left, icon above label:

| Item | Icon | Opens |
|---|---|---|
| Search ⌘K | `search` | The command bar |
| Brain | `brain` | The 3D view of the record |
| Threads | `compass` | Folders, hubs, threads and notes in columns |
| Stats | `hash` | Plain figures about the record |
| Timeline | `calendar-range` | Activity over time |
| Profile | `user-round` | What the record says about you |
| Workbench | `flask-conical` | The table builder and Activity |
| Views | `layout-dashboard` | Charts and lists you pick or describe |
| Assistant | `list-todo` | Your brief, open loops and tasks |
| Guide | `graduation-cap` | How to read the brain |
| + Add | `plus` | Add files, a note or a source |

Keys 1 to 9 open the first nine items after Search; + Add has no key. A Review badge sits on Threads when notes wait
for review. The footer reads "Woven from N entries" and links to Stats.

## Brain

The main view: a dark canvas holding a 3D point cloud in the shape of a standing body, with the brain as its head.

- **Points.** In the head's two lobes, each point is a note, a concept hub or a summary. Every other entry (messages
  and files) hangs on its source's nerve: chat assistants down the arms, coding agents down the legs, other sources
  round the trunk. Along each nerve, time runs from its root at the cord, the oldest, to its tip, today.
- **The cord** down the back is the calendar: a ring at the edge of each month, this month at the top, and a run of
  empty months folded into one fainter ring.
- **Framing** (Brain layout only): Body, Head or Cord brings the camera to that part, fitted to the space the controls
  leave clear. A record of notes alone opens on the head.
- **Colour** is the group: project, folder, source, speaker or hub, chosen in the legend.
- **Moving.** Drag to rotate, scroll or pinch to zoom, double-click a point to open it. The cloud turns slowly on its
  own until you touch it.
- **Hover** shows a small card with the title, date and source.
- **Top right:** a search field that lights up matching points and dims the rest, **Fit** (frames the whole cloud),
  and view settings (point size, line density, labels, slow turning).
- **Legend** along the foot, with a switch for the grouping ("By project", "By folder", "By source", "By speaker").
  Each group shows its count, the list ends in "+N more", and clicking a group isolates it.
- **Layouts:** Brain, Activity (below), and a flat Clusters layout.

## Guide

A side panel titled "Reading your brain", in short plain paragraphs:

- **Hubs:** the large labelled points, one per concept the organiser found.
- **The body:** notes and hubs in the head, every other entry on its source's nerve, the cord as the calendar, and
  what the framings show.
- **Clusters:** points close together share words and links.
- **The index:** what search reads, and how it ranks your own words first.
- **Colour and labels:** what the legend's grouping does, and when labels show.
- **The lines:** a *thread line* joins messages in one conversation; a *cross link* joins two entries in different
  threads that read alike, and in the Brain layout one that reaches down the body stays faint until you light its
  entries or select one of them; a *note link* is a `[[link]]` you wrote; a *hub spoke* joins a hub to each entry it
  holds, but in the Brain layout only to the notes and hubs in the head (Activity, Clusters and the Timeline strip
  join every entry); a *time chain* joins entries in date order; a *label spark* flashes from a label to its points on
  hover; a *label leader* holds a label to its point. Time chains and label sparks are marked Later: not drawn yet.

## Concept hub panel

Opens from the right when you click a hub. The header shows the hub's name, its kind ("Concept hub") and a line saying
this is the organiser's reading of your entries, not your words, with the engine and the run that wrote it. Three
sections follow: **In short**, **What you found** and **Open ends**. Every bullet cites a dated quote of your own
words, and its link opens the entry it came from. Buttons: **Rename**, **Merge into…**, **Not useful** and
**Refresh**.

## Activity layout

The record seen from above as rings: time runs from the centre outward, one ring per year, months as slices. A "How
to read this" box names the four channels: **Place** (when), **Colour** (group), **Size** (how many entries) and
**Lines**. The legend groups points by month, with Untagged and Other notes at the end.

## Timeline

Charts of entries per week, split by source or speaker. Drag across a span and the matching points light up in the
brain, which stays visible in a strip above the chart. Presets: last month, last year, all.

## Workbench

**Table builder:** two properties on the axes (time, folder, project, hub, source, speaker, tag), a third as a
filter, and one of six forms: table, heatmap, bars, stacked bars, lines or dots. Clicking a cell lists its entries.
Views can be saved.

**Activity:** each topic's activity over time as a line, with a linear or log scale and a smoothing slider.

## Threads

Three columns: folders and hubs, then threads and notes, then the reader. Sort by date or name; filter by source,
speaker and date. **Inbox** holds entries not yet filed; **Review** holds notes that may be out of date; **Runs**
lists every organising pass.

## Reader

One entry or a whole thread.

- **Layers,** as tabs left to right: Original, Cleaned, Expanded, Digest, Ideas. Only Original is your words; every
  other tab carries a band naming the engine, model and run that wrote it.
- **Neighbours:** the entries just before and after, and the most similar ones.
- **History:** each version with its editor (import, you, or an agent's name) and date. An entry an agent changed
  says "Edited by an agent" at the top.
- **Buttons:** Edit, Not mine (for a thread), Copy link.

## Notes editor

**Edit** opens the note's Markdown file in a plain editor beside a preview. Typing `[[` suggests note names as you
type. Saving writes the file and adds a version. From the command bar, `note …` adds a line to today's daily note and
`new note …` starts a note with that title.

## Review

Notes the organiser thinks have gone stale, each with the newer entries behind that and the reason in one line. For
each one: **Update** (the proposed change shows as a diff first), **Still holds** or **Skip**. Nothing changes
without a click, and the list marks each note Updated or Still holds once you choose.

## Folders, runs and undo

- **Folders** lists folders with counts. Merging two keeps the old name as an alias, and the toast offers **Undo**.
- **Runs** lists every organising pass with its task, engine, model, time and counts. **Undo run** removes all it
  made.
- ⌘Z undoes the last change.

## Profile

What the record says about you: the topics you return to, your projects by time span, the people you mention, and the
first and latest date for each. Every line links to the entries behind it. **Check a claim** takes a sentence, a line
from a CV say, and shows the entries that back it up or argue with it.

## Stats

Entries, threads, notes, hubs and sources; your words and the assistants'; the busiest months; and how far the
organiser has got (the share of entries tagged, filed and summarised).

## Command bar

One field, ⌘K inside the window and ⌥⌘K from the app menu, for search, questions and commands.

- Typing lists matching entries as you go.
- A question ("when did I first mention X?") answers with a view of your own entries and lights them up in the brain.
- Commands: `note …`, `new note …`, `open …`, `go to …`, `organise`, `undo`, `lock`, `theme …`.

## Compact window

A small window for a side of the screen, with tabs **Brain**, **Notes**, **Write**, **Add** and **More** (Review,
Folders, Runs, Undo). It is the same app at a narrower width, so everything in it also works in the full window.

## Settings

Groups, top to bottom:

| Group | Holds |
|---|---|
| AI agents | Connected agents, **Copy config** for each, **Copy a sample question** |
| AI model | **Local model** (the default: its address, the model file, a **Test** button), **Outside model** (address, model, the env var holding the key), or **No AI** |
| Usage cap | A monthly token cap for an outside model. At the cap, runs wait for the next month |
| Backup | A zip of the record, on demand (**Back up now**) |
| Exclusions | Rules by source, folder or pattern; redaction before any outside model |
| Appearance | Theme and palette |

Proof of date and daily backups aren't in 1.0, and Settings has no switch for either. Both are planned (proof of date
comes with the [ledger](features.md#ledger-and-proof-of-date-planned)). A choice an earlier build stored for them stays
in the config.

## Themes

Six app themes: Dusk (the default), Ink, Slate, Moss, Linen and Paper; the last two are light. Seven palettes for the
points: Ember, Tide, Lichen, Heather, Graphite, Saffron and Mono. The choice is remembered, and every theme keeps text
contrast at WCAG AA or better.

## Lock and updates

**Lock** covers the window with an unlock screen and stops both agent servers until you unlock. Before an agent's
first read, the window asks you to allow it. When a new release is out, a thin banner says "Skeinwise X.Y is out"
with **Update** and **Later**.
