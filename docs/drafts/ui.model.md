### Capture bar

Always at the top of the app window. Buttons: Open command bar (Alt+Cmd+K, Ctrl+Alt+K elsewhere); Add files; Live capture toggle with two status lines under it ('last saved 3 minutes ago', 'caught up 4 chats from Claude Code'); Connect an agent; Get an export (step-by-step guides for ChatGPT, Claude, Gemini); Lock; Settings (Cmd+,). The capture bar is a toolbar that provides quick access to essential functions. It includes a button to open the command bar, which allows users to perform actions like adding files, connecting agents, and exporting data. The live capture toggle shows the last saved time and the number of chats caught up. Users can lock the app to prevent accidental changes. The settings button opens the preferences menu. The export function includes guides for popular AI models. The capture bar is designed for efficiency, with all key actions available in one place. It helps users manage their data and interactions with AI tools quickly and easily.

### Onboarding: Welcome

The first screen on first run shows a simple message: Skeinwise collects and organises your AI chats and notes into a single dated record. It ensures your data stays private by storing everything in the ~/.skeinwise directory. A single Start button appears, inviting the user to begin using the app. Below the button, a link to the documentation is displayed, offering guidance for those who want to learn more. The screen is clean and minimal, focusing on the core purpose of the application. The message is clear and direct, setting the tone for the rest of the onboarding process. The Start button is the only interactive element, encouraging the user to take the next step. The link to the docs is placed in a way that does not distract from the main action. The design is intentional, reflecting the values of simplicity and privacy that define Skeinwise. The user is guided through the onboarding process with precision and clarity.

### Onboarding: Set up

The user is asked to confirm they want to set up Skeinwise. Before anything else, the system creates a record folder at ~/.skeinwise, readable only by the current user. An empty record database is initialized. A local web server is started on 127.0.0.1. An MCP server entry is added for AI agents. The user is shown a list of AI agents found on their computer, including Claude Code, Codex, Cursor, and others. Each agent is listed with a checkbox. A "Set it up" button is displayed. As each step is completed, the corresponding line turns green. The user must click "Set it up" to proceed. Once all steps are done, the system is ready to import AI chats and notes. The onboarding process ensures all necessary components are in place before any data is added. The user has full control over the setup process and can review each step before confirming. The system does not ask for any additional information beyond what is listed.

### Onboarding: Bring in

Skeinwise lists every source found. Sources include Claude code and codex history folders, export files in Downloads (ChatGPT, Claude, Gemini), markdown folders, and Obsidian vaults. For each source, it shows its size (entries, date range) and three choices: Bring it in, Leave it out, Decide later. For note folders, a 'Whose words?' picker is available: mine, or another person's name. A Bring in button imports the chosen ones. The user can select multiple sources to bring in. Each source is processed individually. The system does not modify the original files. The user decides which sources to include in the record. The import process is straightforward. The user can review each source before finalizing the import. The system supports multiple file types. The user can choose to bring in all, some, or none of the sources. The 'Whose words?' picker helps identify the owner of the notes. The import process is designed to be simple and clear. The user has full control over which sources are included. The system respects the user's choice.

### Onboarding: Watch it grow

The Map fills in live while the import and the first organiser run happen. As the system processes the data, the Map updates in real time, showing the structure of the records. A counter displays the number of entries, threads, and hubs, giving the user a sense of progress. The interface is designed to be intuitive, with clear indicators of what is being done. When the import and organiser processes finish, a short tour is offered. The tour provides three tips to help the user understand how to navigate and use the system effectively. After the tour, a Done button appears. Clicking it opens the main window, allowing the user to start exploring their data. The onboarding process is seamless and designed to help the user feel confident and prepared as they begin using Skeinwise.

### Rail

A narrow left column of icons with labels: Search (Cmd+K), Map, Browse, Figures, Timeline, Portrait, Lab, Guide, and + Add at the bottom. The footer reads 'Woven from N entries' and links to the record's stats. The selected item is highlighted; keyboard shortcuts 1 to 8 switch views. Each icon represents a function or view. Search allows finding content quickly. Map shows a visual representation of the record. Browse lists items in a directory. Figures displays diagrams or images. Timeline shows events in order. Portrait shows a summary of the record. Lab is for creating and managing notes. Guide helps users navigate the app. + Add opens a form to create a new item. The footer provides information about the record's size and structure. The selected item is visually emphasized. Keyboard shortcuts allow users to switch between different views efficiently.

### The Map

The main 3D view is a dark canvas with a point cloud shaped like a brain, featuring two lobes and a twisted, helical stem. Each point in the lobes represents a note, topic hub, or summary; the stem holds the original messages and files, arranged in time order from the base upward. Points are colored by group, such as folder, source, speaker, or hub, as chosen in the legend. Users can drag to rotate the view, scroll to zoom, and double-click a point to open it. Hovering over a point displays a card with the title, date, and source. In the top right, a search field highlights matches, along with a Fit button and a view-settings button for adjusting point size, line density, and label visibility. The legend at the foot lists groups with counts and '+N more' for additional groups. Clicking a legend item isolates that group for focused exploration.

### Guide

A side panel titled 'How to read your map' explains the elements of the 3D map. Points include hubs, which are large and labelled, and notes, summaries, and originals in the stem. Clusters group related points. Lines connect points in various ways: thread lines show messages in one conversation, cross links show two entries about the same thing, note links show [[link]]s you wrote, hub spoked show entries filed under a hub, time chains show entries in date order, and label leaders show connections from a label to its point. Colour indicates the group, and size shows how many entries a point gathers. Hubs are central to the map and often contain multiple links. Notes and summaries are connected to hubs or other points. Originals are in the stem and not linked. Clusters are groups of points with similar themes. The map helps you explore your records in a visual and interactive way. Understanding these elements allows you to navigate and search your data effectively.

### Hub panel

Opens when a hub point is clicked. Header: the hub's name, its kind ('Topic hub'), and a note that the organiser wrote it, with the engine and run. Three sections: In short; What you found; Open ends. Every bullet cites a dated quote of the person's own words, with a link that opens the entry it came from. Buttons: Rename, Merge into…, Not useful (removes it), Regenerate. 

- In short: "This is where I keep all the important stuff." [entry 2023-10-05]
- What you found: "I found a lot of useful information here." [entry 2023-10-06]
- Open ends: "I need to finish this later." [entry 2023-10-07]

Clicking Rename changes the hub's name. Clicking Merge into… combines this hub with another. Clicking Not useful removes the hub. Clicking Regenerate creates a new hub based on the current one.

### Year rings

The Map layout shows rings around a central point, with each ring representing one year. Time moves outward from the center. Each ring is divided into slices for months. A "How to read this" box explains how to interpret the position (when), color (group), size (entries), and lines. The legend shows categories by month, untagged items, and other notes. Users can switch back to the brain shape from the same menu. The rings allow users to see data organized by time, making it easy to find information from different years. The monthly slices help in locating data within a specific time frame. The color coding helps identify groups or categories. The size of each ring indicates the number of entries for that year. The lines connect related entries. The legend provides a quick reference for understanding the different types of data. The layout is designed for easy navigation and understanding of time-based data. Users can use this view to explore information in a structured way. The ability to switch between views helps users find the most appropriate way to interact with their data.

### Timeline

The app displays charts of activity over time, showing entries per week, split by source or speaker. Users can drag across a span to select a date range, which highlights the matching points in the Map view. The Map stays visible above the chart for easy reference. A date range picker is available, along with presets for last month, last year, and all time. The charts allow users to see trends and patterns in their data. The timeline feature helps users understand when and how often they interact with their records. By selecting a date range, users can focus on specific periods of activity. The connection between the timeline and the Map makes it easier to explore and understand the data. The date range picker provides quick access to common time frames. Users can customize their view to suit their needs. The timeline is a useful tool for tracking and analyzing activity over time.

### Lab

A table builder. Pick any two properties for the axes (time, folder, source, speaker, tag, hub) and a third as a filter. Six forms: table, heatmap, bars, stacked bars, lines, dots. Clicking a cell lists its entries. A second tab, Tides, draws each topic's activity over time as a line, with a linear or log scale and a smoothing slider. Views can be saved.

### Browse

A three-column browser: folders and hubs on the left, threads and notes in the middle, the reader on the right. Sort by date or name. Filters for source, speaker and date. Shows an 'Inbox' folder for entries not yet filed.

The left column lists all folders and hubs. Each folder contains related threads and notes. Hubs group related folders. The middle column displays threads and notes, sorted by the chosen criteria. The right column shows the selected item in full detail.

Users can sort items by date or name. Filters allow narrowing down results by source, speaker, and date. The inbox folder holds entries that have not been filed yet. These entries can be reviewed and organized as needed.

The browser provides a clear way to navigate and find information. It supports both structured and unstructured data. Users can easily move between different types of content. The interface is designed for quick access and efficient organization.

### Reader

The reader can view one entry or one whole thread. Layer tabs include Original, Cleaned, Expanded, Digest, and Ideas. Only the Original tab contains the person's own words. The other tabs show text generated by specific engines, models, and runs. A side list displays neighboring entries, showing what comes before, after, and what is most similar. A History list shows each version of an entry with the editor's name and date. The entry may have been changed by an agent, in which case it shows "Edited by an agent" at the top. The reader can click Edit to modify the entry. There is also a "Not mine" button for a thread, and a Copy link button to share the entry. The interface allows the user to explore and interact with their data in a structured and organized way.

### Notes editor

Edit opens the note's Markdown file in a plain editor with a preview. Typing [[ suggests note names. Saving writes the file and adds a version. From the command bar, 'note …' appends a line to today's daily note and 'new note …' starts a note with that title. The editor supports basic text formatting and syntax for linking to other notes. Changes are saved locally and versioned. The preview updates in real-time as the user types. The command bar provides quick access to common actions. The note's history is preserved in the file's version history. The editor is designed for simplicity and direct interaction with the note's content. Users can add new notes or modify existing ones without leaving the editor. The preview helps users see the formatted output as they work. The system does not store or process the note's content beyond what is written in the Markdown file. The editor is a lightweight tool for editing and viewing notes. The command bar allows for efficient note management. The note's content is stored in a structured format that supports future expansion and integration with other features.

### Review

The review section displays a queue of notes the organiser believes may be out of date. Each entry includes a proposed change shown as a diff. The status of each item is either "Update," "Still holds," or "Skip." The rail at the top shows a count badge indicating how many items are in the queue. Changes are not applied automatically; they require a click to confirm. The organiser can review each note, see the differences, and decide whether to update it or skip it. This allows for careful management of potential outdated entries. The interface is designed to help the user maintain accurate and up-to-date records. The review process is part of the organisation workflow, ensuring that notes are correctly maintained. The system does not alter the original notes unless the user explicitly approves the changes. This ensures that the original data remains intact while allowing for necessary updates. The review section is a key part of the organisation process, helping to keep the records accurate and reliable.

### Folders and undo

The app shows a Folders list with the number of entries in each folder. You can merge two folders. When you merge, the old name stays as an alias. The toast offers Undo. A Runs list shows every organiser run. Each run has its task, engine, model, time, and counts. You can Undo a run. Undoing a run removes everything that run made. You can also Undo after any change with Cmd+Z. The app remembers all changes and allows you to revert to previous states. The undo functionality works for folders and runs. The app keeps track of all actions so you can easily go back. The user can review the history of runs to understand what was done. The undo feature is available in both folder operations and run actions. The app ensures that you can always go back to a previous version of your data. The undo process is straightforward and reliable. The app is designed to help you manage your data with confidence. The user can rely on the undo feature to correct mistakes or revert to earlier states. The app supports both local and remote operations. The undo feature is consistent across all functions. The app is built to be intuitive and easy to use. The user can trust the app to handle their data accurately.

### Portrait

This page shows the person as they appear in the record. It lists the topics they return to most, the projects by time span, the people they mention, and the first and latest dates for each. Every line links to the entries behind it. The 'Check a claim' box takes a sentence, such as one from a CV, and shows the entries that support or contradict it. 

The topics section highlights recurring themes in their notes and chats. The projects section organizes their work by when it was started and finished. The people section shows who they mention most often. The dates show when each topic or project first appeared and when it last appeared. 

Each line in the portrait is connected to the actual entries. This lets the user see the full context of each point. The 'Check a claim' feature helps verify statements by showing relevant entries. It makes it easy to see what is true and what may be false. 

This portrait gives a clear view of the person's life and work as recorded. It is a summary of their activities and relationships. It is built from the data they have provided.

### Figures

There are 12,500 entries. 3,200 threads. 8,700 notes. 45 hubs. 2,300 sources. 9,800 words by you. 14,200 words by assistants. The busiest months are July and August. Organiser coverage is 68%: 68% of entries are tagged, 68% are filed, and 68% are summarised. The average entry has 12 threads. The average note has 4 sources. The average hub has 15 entries. The average source has 3 notes. The average word is 12 characters. The average entry is 1,200 words. The average note is 300 words. The average thread is 50 words. The average source is 150 words. The average hub is 2,000 words. The average assistant word is 14 characters. The average user word is 13 characters. The average entry is 12 minutes of text. The average note is 3 minutes. The average thread is 1 minute. The average source is 1.5 minutes. The average hub is 20 minutes.

### Command bar

One field (Cmd+K) for search, questions and commands. Typing shows matching entries live. A question ('when did I first mention X?') returns a view of the person's own entries, highlighted in the Map. Commands: note …, new note …, open …, go to …, run tagging, undo, lock, theme …. 

The command bar is a single input field accessible via Cmd+K. As the user types, the interface displays entries that match the input in real time. The bar supports asking questions about the data, such as "when did I first mention X?" which then shows relevant entries in the Map view, with the matching content highlighted. 

Users can also issue commands to perform actions. These include creating or opening notes, navigating to specific entries, running tagging processes, undoing changes, locking entries for protection, and switching themes. The command bar serves as a direct interface for interacting with the system, allowing users to search, ask, and control the application efficiently. It is designed to be intuitive and responsive, ensuring that users can quickly find and manipulate their data.

### Settings

Sections include Engine, Budget, Privacy, Agents, Sync, Proof of date, Backup, and Appearance.

Engine: Choose between No AI, a local model via an OpenAI-compatible URL, or a hosted endpoint. Include a Test button.

Budget: Set a monthly token cap. If exceeded, the service pauses until reset.

Privacy: Redact names, emails, phone numbers, addresses, and health words before any outside model uses the data. Set exclusion rules by source, folder, or pattern. Define permissions for the record folder and check for disk encryption.

Agents: Connect agents. Copy config for each agent. Include a sample question for reference.

Sync: Choose an encrypted bundle folder. Set a passphrase and recovery words.

Proof of date: Toggle on or off to confirm the record's date.

Backup: Include a backup option.

Appearance: Choose a theme and palette for the interface.

### Themes

The app offers six themes: Dusk, Linen, Slate, Moss, Ink, and Paper. Each theme provides a distinct visual style. There are seven data palettes for the points: Ember, Tide, Lichen, Heather, Graphite, Saffron, and Mono. Users can choose a theme and a data palette. The selection is remembered across sessions. Colors in each theme and palette are chosen to ensure sufficient contrast between text and background. This ensures readability in all scenarios. The themes and palettes are designed to work together, maintaining consistency in the user interface. Users can switch between themes and palettes as needed. The color choices are based on a balance of aesthetics and functionality. The system does not alter the original data when applying themes or palettes. The visual elements are applied only to the interface, not to the content. The choice of theme and palette is stored locally, ensuring that the user's preferences are retained without relying on external services. The design respects the user's ability to customize their experience while maintaining a cohesive and accessible interface.

### Lock and updates

Lock hides the window content behind a passphrase screen and stops the agent tools until unlocked. The user must enter the correct passphrase to view the content again. This ensures that the data remains secure and accessible only to the user. When a new release exists, a thin banner appears at the top of the window saying 'Skeinwise X.Y is out' with buttons for 'Update' and 'Later'. The 'Update' button allows the user to install the new version, while 'Later' saves the notification for future review. The system checks for updates automatically in the background. If the user chooses to update, the application downloads the new version and prompts them to restart. The update process does not affect the existing data or the locked content. The user can unlock the window again after the update is complete. The system ensures that the locked content remains intact during the update process. The update banner is removed once the user has either updated or chosen to review it later.
