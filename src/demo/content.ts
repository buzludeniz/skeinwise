// The demo record: an invented person's chats and notes, written for Skeinwise. No real person or data.

export interface DemoTopic {
  key: string;
  /** Active window, as [first month, last month] in YYYY-MM. */
  window: [string, string];
  threads: number;
  /** Where the chats come from. */
  sources: ('chatgpt' | 'claude' | 'claude-code')[];
  titles: string[];
  you: string[];
  assistant: string[];
  /** Dated decisions, in order; each lands in its own thread near that month. */
  decisions: { month: string; text: string }[];
  /**
   * Notes, each dated early in the window unless `created` (YYYY-MM-DD) says when. A note written after the decisions
   * it already holds isn't overtaken by them, so review leaves it alone.
   */
  notes: { title: string; tags: string[]; body: string; created?: string }[];
}

/** A thread written out in full, for the parts of the story a seeded draw would blur. */
export interface ScriptedThread {
  source: 'chatgpt' | 'claude' | 'claude-code';
  /** When it starts, as an ISO time. */
  at: string;
  title: string;
  /** The messages in order, yours first, then the assistant's, and so on. */
  turns: string[];
}

/**
 * Plotline's development across three tools: four long working sessions, and the story of one decision. In August,
 * in ChatGPT, the waiting list stays in SQLite on the shed laptop; in October, in Claude Code, after a plot is offered
 * twice, it joins the rest of Plotline in Postgres. The sessions' lines carry no change cue, so only the story moves
 * the review. Few threads, many turns: the organiser's group count grows with the number of threads, and the demo
 * keeps 8 hubs.
 */
export const PLOTLINE_DEV = {
  key: 'plotline',
  window: ['2026-05', '2026-11'] as [string, string],
  /** One session per source listed; each takes `turns` exchanges from `pairs`, in a seeded order. */
  sessions: ['claude-code', 'chatgpt', 'claude-code', 'claude'] as ('chatgpt' | 'claude' | 'claude-code')[],
  turns: [18, 22] as [number, number],
  titles: ['Plotline: offer expiry and emails', 'Plotline: tests and CI', 'Plotline: committee pages', 'Plotline: three sites'],
  /** What you asked, and what came back. */
  pairs: [
    ['The offer expiry job should run every hour, not once a night, so nobody waits a whole day for the next offer.', 'An hourly job that closes expired offers and sends the next one keeps the wait under an hour. Lock the plot row so two runs never send the same offer.'],
    ['CI takes nine minutes now. Most of it is the browser tests for the booking form.', 'Running the browser tests only when the booking form changes cuts CI to about three minutes; the rest of the suite still runs on every push.'],
    ['Can a screen reader get through the booking form? Two people on the committee use one.', 'Give every field a visible label and put each error next to its field; then the form reads well with a screen reader.'],
    ['Write the deploy checklist for Plotline: backup first, run the migrations, then restart the web server.', 'Here is the checklist: take a backup and check that it restores, run the migrations, restart the web server, then open the waiting list page.'],
    ['The council pays the hosting bill: 12 a month for the server, and the backups cost 2 more.', 'That covers one small server and its backups. Put the bill in the committee report once a year.'],
    ['Give me test data for Plotline: 64 plots, 41 people on the waiting list, and three shared plots.', 'Here is a seed script: 64 plots, 41 people waiting, three shared plots and a year of offers.'],
    ['When an offer expires, the email to the next person should say how long they have to answer.', "The offer email now says when the offer ends, in the reader's own time, with links to accept or decline."],
    ['Show the history of a plot: who held it, for how long, and what they noted about the soil.', 'The plot history page reads from the offer log and the soil notes, newest first.'],
    ['The waiting list page is slow with 41 names. Is it the query or the template?', 'It is the query: it loads every offer for every person. An index on offers by plot and status makes the page fast again.'],
    ['Plotline should keep a log of every offer: sent, accepted, expired or declined.', 'One table of offer events gives you the log, the plot history and the weekly email from the same rows.'],
    ['How do I test the 48 hour window without waiting 48 hours?', 'A fake clock in the tests moves time forward 48 hours in one line, so the expiry test runs in milliseconds.'],
    ['The three allotment sites need separate waiting lists but one login for the committee.', 'Each site gets its own waiting list, and committee members get a role per site under one login.'],
    ['Add a weekly email to the committee with the plots offered, accepted and still open.', 'The weekly email lists offers sent, accepted and still open, one section per site, every Monday at 07:00.'],
    ['The plot rent goes up in April. Can the renewal reminder show the new rent?', 'The renewal reminder can read the new rent from the plots table, with the date it starts.'],
    ['Someone accepted plot 9 twice by double-clicking the button.', 'The accept button turns off after the first click now, and the server ignores a second accept for an offer that is already taken.'],
    ['The printable map cuts off plot 64 on A4.', 'The map scales to the page now: A4 fits all 64 plots in two columns, and A3 keeps one row per bed.'],
    ['Can the watering rota skip a holder who is away?', 'A holder can mark days away; the rota passes their turn to the next neighbour and tells both of them.'],
    ['Write a test for a shared plot where one holder gives it up.', 'Here is the test: the plot stays with the other holder, and nobody on the waiting list gets an offer.'],
    ['The reminder emails land in spam for two holders.', "Sending from the allotment's own domain with SPF and DKIM keeps them out of spam; here are the two DNS records."],
    ['Add a page for the committee to see who has not answered an offer yet.', 'The open offers page lists each offer with the person, the plot and the hours left, soonest first.'],
    ['Plotline crashed last night when the backup ran during the offer job.', 'The backup locked a table the job needed. Run the backup at 03:00 and the job at five past each hour, and give the job a short timeout.'],
    ['Review this migration before I run it on the live database.', 'It is safe to run: it adds a column with a default and an index, and it can be undone. Run it after the 03:00 backup.'],
    ['How many people got a plot from the waiting list this year?', 'Nineteen offers were accepted this year, out of 31 sent; the rest expired or were declined.'],
    ['Plot holders want a reminder the day before their watering turn.', 'A daily job at 18:00 emails everyone whose turn is tomorrow, with the plot number and the tap code.'],
    ['Make the booking form work on a phone in the sun: big buttons, high contrast.', 'Buttons are 48 pixels tall now, the text is dark on white, and the form fits a phone screen without zooming.'],
    ['Explain the offer job to me as if I will look after it alone next year.', "Every hour it finds offers past their 48 hours, marks them expired, offers the plot to the next person on that site's list, and logs each step."],
    ['Can Plotline export the plot register for the council as a spreadsheet?', 'The register export writes one row per plot with the holder, the start date and the rent, as a CSV the council can open.'],
    ['The soil notes should stay when a plot changes hands.', 'Soil notes belong to the plot now, not the holder, so they stay when the plot changes hands.'],
    ['Write the README section on how to run Plotline on a new laptop.', 'Here is the section: install Postgres, copy the example settings, load the seed data, and start the server with one command.'],
    ['What would break if the server lost power during an offer?', 'Nothing is lost: each offer change is one transaction, so a half-done change is rolled back and the next run picks it up.'],
  ] as [string, string][],
  story: [
    {
      source: 'chatgpt',
      at: '2026-08-11T19:20:00.000Z',
      title: 'Postgres or SQLite for the waiting list?',
      turns: [
        'Postgres or SQLite for the waiting list? Plotline has been on Postgres since April, but the waiting list runs on the laptop in the shed at Wend Lane, and the shed is offline half the time.',
        'If the shed is often offline, a SQLite file on the laptop keeps the waiting list working there. Copy new offers to Postgres once a night, and let the laptop be the one place the list changes.',
        'Decided: the waiting list stays in SQLite on the shed laptop, copied to Postgres every night.',
        'Then make the nightly copy safe to run twice: write offers by their id, and never delete anything on the Postgres side.',
      ],
    },
    {
      source: 'claude',
      at: '2026-09-29T07:45:00.000Z',
      title: 'Plot 17 offered twice',
      turns: [
        'Two households got an offer for plot 17 on the same morning. The shed laptop had passed the offer on, and the nightly copy brought the old one back.',
        'That is the price of two copies of the list: each side can change an offer while the other can not see it. Either one side owns offers outright, or both live in one database.',
      ],
    },
    {
      source: 'claude-code',
      at: '2026-10-14T20:05:00.000Z',
      title: 'Waiting list into Postgres',
      turns: [
        'Changing my mind on the waiting list: after plot 17 was offered twice, it moves out of SQLite on the shed laptop and into Postgres with the rest of Plotline.',
        "Plan: a migration that adds the waiting list and offers tables to Postgres, a one-off import from the laptop's SQLite file, and the expiry job reading and writing both in one transaction.",
        'The shed laptop gets a read-only waiting list page, kept for when the network drops.',
        'Done: the migration, the import, and a test that two open offers for the same plot are refused. All 212 tests pass.',
        'Now remove the nightly copy job and its schedule.',
        'Removed the nightly copy job, its schedule and its two tests. Nothing else read from it.',
      ],
    },
  ] as ScriptedThread[],
};

/**
 * The invented person's own tag list. Words from a description tag an entry when two of them are in it, so the No-AI
 * tagger is sure that "Sourdough schedule" is about finance: the starter's feeding rate and the dough's rise. That is
 * the wrong tag the demo keeps on purpose, for showing how undo takes back a run.
 */
export const DEMO_TAGS = [
  { schema: 'Areas', tag: 'finance', words: 'money budget bank savings bills rent rate rise interest loan cost costs' },
  { schema: 'Areas', tag: 'fitness', words: 'ride riding training km climbing legs rest stretch' },
];

export const TOPICS: DemoTopic[] = [
  {
    key: 'plotline',
    window: ['2025-02', '2026-11'],
    threads: 16,
    sources: ['claude-code', 'chatgpt'],
    titles: [
      'Plotline booking flow',
      'Plot waiting list logic',
      'Plotline: reminder emails',
      'Watering rota for Plotline',
      'Plotline map of the allotment',
      'Fix double bookings in Plotline',
    ],
    you: [
      'Plotline needs a waiting list: when a plot frees up, the next person gets 48 hours to accept before it moves on.',
      'Can you write the booking form so a plot holder can swap their watering day with a neighbour?',
      'The allotment committee wants a printable map of all 64 plots with who holds each one.',
      'Reminder emails are going out twice. I think the job runs on both servers.',
      'Let us keep Plotline boring: one server, one database, a nightly backup.',
      'Add a field for soil notes on each plot so new holders know what grew there before.',
      'The waiting list has 41 names now. Sort it by date joined, not by name.',
      'How should Plotline handle a plot shared by two households?',
      'Write a test for the case where someone accepts a plot after their 48 hours ran out.',
    ],
    assistant: [
      'A shared plot can have two holders with equal rights; the booking belongs to the plot, and either holder can swap a watering day.',
      'The double send comes from the scheduler starting on each instance. Take a lock in the database before sending, so only one run sends.',
      'For the printable map, an SVG grid of the plots with holder initials prints cleanly on A3.',
      'Here is a migration that adds soil_notes to plots, plus the form field and a test.',
      'An offer that expires should move to the next person automatically; a daily job can sweep expired offers.',
      'Sorting by joined_at keeps the list fair; I added an index on it so the page stays fast.',
    ],
    decisions: [
      { month: '2025-03', text: 'Decided: Plotline runs on SQLite. It is one allotment with 64 plots, not a city.' },
      { month: '2026-04', text: 'Changing my mind on SQLite: the council wants Plotline for all three allotment sites, so we move to Postgres.' },
    ],
    notes: [
      {
        title: 'Plotline',
        tags: ['project', 'plotline'],
        body: 'Booking app for the Wend Lane allotment. 64 plots, waiting list, watering rota.\n\nSee [[Plotline waiting list rules]] and [[Allotment committee]].\n\n- One server, one database, nightly backup.\n- Plot holders swap watering days themselves.',
      },
      {
        title: 'Plotline waiting list rules',
        tags: ['plotline'],
        body: 'When a plot frees up, the next person on the list gets 48 hours to accept.\n\nIf they do not answer, the offer moves on. Shared plots have two holders.\n\nRelated: [[Plotline]].',
      },
      {
        title: 'Allotment committee',
        created: '2026-11-02',
        tags: ['plotline', 'people'],
        body: 'Meets the first Tuesday of the month. Jun keeps the plot register; Mara runs the seed swap.\n\nThey asked for a printable map of the plots for the shed door. See [[Plotline]].',
      },
    ],
  },
  {
    key: 'sourdough',
    window: ['2024-03', '2026-10'],
    threads: 12,
    sources: ['chatgpt', 'claude'],
    titles: ['Sourdough starter is sluggish', 'Rye sourdough timings', 'Why is my crumb so tight?', 'Baking in a cold kitchen'],
    you: [
      'My starter only doubles after ten hours. The kitchen is about 17 degrees in winter.',
      'I fed the starter at 1:5:5 last night and it smelled like nail polish this morning.',
      'The loaf spread flat in the oven. Was the dough over-proofed?',
      'I want a rye loaf for the weekend market stall: dense, sour, slices thin.',
      'The crumb came out tight with a few big holes near the top.',
      'Can I retard the dough in the fridge overnight and bake straight from cold?',
      'Twelve loaves for the stall on Saturday. How do I plan the timings with one oven?',
    ],
    assistant: [
      'At 17 degrees a starter slows a lot. A warmer spot, such as the oven with only the light on, brings it back to four to six hours.',
      'The nail polish smell means the starter is hungry. Feed it more often, or at a richer ratio, for a few days.',
      'Spreading flat usually means over-proofing or weak shaping. Try a shorter bulk and a tighter pre-shape.',
      'A tight crumb with a few big holes points to under-fermentation. Let the bulk run until the dough is about 50 percent bigger.',
      'Yes: baking straight from the fridge works well, and the cold dough is easier to score.',
      'For twelve loaves and one oven, stagger the shaping by 45 minutes and keep the waiting loaves in the fridge.',
    ],
    decisions: [
      { month: '2024-11', text: 'Decided: the market stall sells only two loaves, a white sourdough and a rye. No more experiments on stall days.' },
    ],
    notes: [
      {
        title: 'Sourdough schedule',
        created: '2024-12-06',
        tags: ['baking'],
        body: 'Friday 18:00 feed the starter, 1:5:5 by weight; in winter, raise the feeding rate to twice a day. Saturday 08:00 mix, let the dough rise until it is 50 percent bigger, shape, fridge overnight. Sunday bake from cold at 250 then 230.\n\nWinter: put the starter in the oven with the light on. See [[Market stall]].',
      },
      {
        title: 'Market stall',
        created: '2024-12-07',
        tags: ['baking', 'stall'],
        body: 'Saturday market, Wend Lane. Two loaves only: white sourdough and rye.\n\nTwelve loaves sells out by 11. Stagger shaping by 45 minutes.',
      },
    ],
  },
  {
    key: 'river',
    window: ['2024-01', '2025-09'],
    threads: 14,
    sources: ['claude', 'chatgpt'],
    titles: ['Nitrate readings on the Wend', 'Thesis chapter 3 outline', 'Sampling plan for spring', 'Plotting the river data'],
    you: [
      'My nitrate readings jump after every heavy rain at the three sites below the farm outflow.',
      'Dr Okafor wants chapter 3 to compare the upstream and downstream sites month by month.',
      'I have 18 months of samples from six sites. What is a fair way to test whether the outflow matters?',
      'Can you help me plot nitrate against rainfall with one panel per site?',
      'Should I drop the March samples? The probe was miscalibrated for two weeks.',
      'The spring sampling plan: every Tuesday at the six sites, plus within 24 hours of any storm.',
      'Rewrite this paragraph so it says what the data shows and nothing more.',
    ],
    assistant: [
      'A mixed model with site as a random effect and rainfall as a covariate fits your design and handles the uneven sampling.',
      'Keep the March samples but flag them, and run the analysis with and without them; report both.',
      'One panel per site with a shared y axis makes the jump after storms easy to compare across sites.',
      'Upstream and downstream pairs month by month show the effect directly; a paired test fits that comparison.',
      'Here is a tighter version of the paragraph: it states the rise after storms and its size, and leaves the cause to the discussion.',
    ],
    decisions: [
      { month: '2024-06', text: 'Decided: the thesis question is whether the farm outflow raises nitrate on the Wend, not the whole catchment.' },
      { month: '2025-02', text: 'Decided with Dr Okafor: keep the miscalibrated March samples, flagged, and report the analysis both ways.' },
    ],
    notes: [
      {
        title: 'Wend river survey',
        created: '2025-03-04',
        tags: ['thesis', 'river'],
        body: 'Six sites, three above and three below the farm outflow. Samples every Tuesday, plus after storms.\n\nQuestion: does the outflow raise nitrate? See [[Chapter 3 plan]].',
      },
      {
        title: 'Chapter 3 plan',
        created: '2025-03-11',
        tags: ['thesis'],
        body: 'Compare upstream and downstream month by month. Mixed model, site as random effect, rainfall as covariate.\n\nMarch samples: flagged, analysis both ways. Supervisor: Dr Okafor.',
      },
    ],
  },
  {
    key: 'rust',
    window: ['2024-09', '2025-06'],
    threads: 10,
    sources: ['claude-code', 'chatgpt'],
    titles: ['Rust borrow checker confusion', 'Rust: parsing the sensor CSV', 'Lifetimes in my parser', 'Rust error handling'],
    you: [
      'Why does the borrow checker complain when I push to a vector while holding a reference to its first item?',
      'I am rewriting the river data cleaner in Rust to learn it. The CSV has 40,000 rows.',
      'When should I use anyhow and when should I write my own error type?',
      'My parser struct holds a &str into the file buffer and now everything needs lifetimes.',
      'The Rust version runs in 0.3 seconds. The Python one took 14.',
    ],
    assistant: [
      'Pushing may move the whole vector to new memory, which would leave your reference pointing at freed space; that is what the borrow checker prevents.',
      'Use anyhow in a binary where you only report errors, and your own error enum in a library whose callers need to match on them.',
      'Owning the strings (String instead of &str) removes the lifetimes at the cost of some copying, which is fine for 40,000 rows.',
      'The csv crate with serde derives turns each row into a struct in a few lines.',
    ],
    decisions: [{ month: '2024-12', text: 'Decided: keep the river cleaner in Rust; the Python version goes to the archive.' }],
    notes: [
      {
        title: 'Learning Rust',
        created: '2025-01-15',
        tags: ['rust', 'learning'],
        body: 'Ownership: one owner, many readers or one writer. Pushing to a Vec can move it.\n\nProject: rewrite the [[Wend river survey]] data cleaner. 14 s in Python, 0.3 s in Rust.',
      },
    ],
  },
  {
    key: 'cycling',
    window: ['2025-03', '2025-08'],
    threads: 10,
    sources: ['chatgpt', 'claude'],
    titles: ['Coast to coast route', 'Packing list for the ride', 'Training plan for July', 'Where to camp on day 3'],
    you: [
      'Mara and I want to ride coast to coast in July: about 220 km over four days, with camping.',
      'Day 3 has 1,400 metres of climbing. Can we split it differently?',
      'What should go on the packing list if we camp three nights and carry everything?',
      'I can ride 60 km comfortably now. How do I build up to back-to-back 60 km days?',
      'Is there anywhere to camp near the reservoir on day 3?',
    ],
    assistant: [
      'Splitting at the reservoir puts most of the climbing on day 2 and leaves day 3 short, which helps if the weather turns.',
      'For three nights of camping: a light tent, two sleeping mats, a stove, one pot, a repair kit, two spare tubes, and layers rather than one heavy jacket.',
      'Ride two days in a row every weekend in June, adding 10 km each week, with an easy week before you leave.',
      'Book campsites ahead in July; the reservoir site fills on weekends.',
    ],
    decisions: [
      { month: '2025-04', text: 'Decided with Mara: four days, coast to coast, camping, splitting the route at the reservoir.' },
      { month: '2025-07', text: 'We finished the ride: 224 km in four days. Day 2 was the hardest, as planned.' },
    ],
    notes: [
      {
        title: 'Coast to coast ride',
        created: '2025-08-03',
        tags: ['cycling', 'travel'],
        body: 'With Mara, July 2025. 220 km, four days, camping. Split at the reservoir.\n\nPacking: tent, two mats, stove, one pot, repair kit, two tubes, layers.',
      },
    ],
  },
  {
    key: 'studio',
    window: ['2024-05', '2026-03'],
    threads: 10,
    sources: ['chatgpt', 'claude'],
    titles: ['Home studio acoustics', 'Recording vocals in a small room', 'Mixing the band demo', 'Which audio interface?'],
    you: [
      'My spare room is 3 by 3.5 metres and the vocals sound boxy. What helps most for little money?',
      'Theo wants the band demo by the end of the month: four songs, recorded live in the room.',
      'The kick drum and the bass fight each other in the mix.',
      'Do I need an interface with four inputs, or will two do for drums?',
      'The vocal takes have a lot of room sound. Can I fix that in the mix?',
    ],
    assistant: [
      'In a small room, thick panels at the first reflection points and behind the singer do more than anything else for the money.',
      'Cut the bass a little where the kick has its weight, around 60 to 80 Hz, or sidechain the bass to the kick.',
      'Two inputs can record drums with a kick mic and one overhead; four gives you a snare mic and stereo overheads.',
      'Room sound is hard to remove later. A duvet behind the singer while recording helps more than any plugin.',
    ],
    decisions: [{ month: '2025-01', text: 'Decided: buy two acoustic panels and a duvet stand before buying any new microphone.' }],
    notes: [
      {
        title: 'Band demo',
        created: '2025-02-08',
        tags: ['music', 'band'],
        body: 'Four songs with Theo, recorded live in the spare room.\n\nKick and bass: cut bass at 60 to 80 Hz. Vocals: duvet behind the singer.',
      },
    ],
  },
  {
    key: 'career',
    window: ['2025-10', '2026-06'],
    threads: 8,
    sources: ['claude', 'chatgpt'],
    titles: ['Rewriting my CV', 'Interview prep: data analyst', 'Should I take the council job?', 'Cover letter for the water trust'],
    you: [
      'I want to move from lab work into data analysis. How do I write my CV so the river project counts?',
      'Interview on Thursday for a data analyst role at the water trust. What will they ask?',
      'The council offered me a job maintaining their planning data. It pays less but it is close to home.',
      'Help me describe Plotline on my CV without making it sound bigger than it is.',
      'They asked for an example of a time the data showed me I was wrong.',
    ],
    assistant: [
      'Lead with the analysis: 18 months of samples from six sites, a mixed model, and a result the supervisor used.',
      'For the change-of-mind question, the March samples are a good story: you kept them, flagged them, and reported both analyses.',
      'Describe Plotline plainly: a booking app used by 64 plot holders, which you built and run.',
      'Weigh the council job on what you want to learn in two years, not only on pay and distance.',
    ],
    decisions: [{ month: '2026-05', text: 'Decided: I accepted the data analyst job at the water trust. I start in July.' }],
    notes: [
      {
        title: 'Job search',
        created: '2026-05-12',
        tags: ['career'],
        body: 'Goal: move from lab work to data analysis.\n\nStories: the [[Wend river survey]] analysis; [[Plotline]] with 64 users; keeping the March samples.\n\nMay: took the data analyst job at the water trust, starting in June.',
      },
    ],
  },
  {
    key: 'reading',
    window: ['2024-02', '2026-11'],
    threads: 9,
    sources: ['claude', 'chatgpt'],
    titles: ['Notes on attention', 'Book: slow productivity', 'Habits that stuck', 'Reading list for winter'],
    you: [
      'I keep reading about attention. The common thread: fewer projects at once, and longer blocks of time.',
      'Summarise what I should actually change from this chapter, in three lines.',
      'Which of my habits stuck this year? Baking every Saturday did; morning runs did not.',
      'Suggest five books for winter: one on rivers, one on craft, and three on how people think.',
      'Is it true that writing things down by hand helps memory, or is that a myth?',
    ],
    assistant: [
      'The three changes: keep two projects active at most, protect one long morning block, and end each day by writing the next step.',
      'Habits that stick tend to be tied to a fixed time and place, like your Saturday bake.',
      'The evidence on handwriting is mixed: it seems to help when it makes you summarise rather than copy.',
    ],
    decisions: [{ month: '2025-01', text: 'Decided: no more than two big projects at once. Right now that is the thesis and Plotline.' }],
    notes: [
      {
        title: 'On attention',
        created: '2025-02-16',
        tags: ['reading', 'ideas'],
        body: 'Fewer projects at once. One long morning block. Write the next step before stopping.\n\nTwo projects now: [[Wend river survey]] and [[Plotline]].',
      },
    ],
  },
];
