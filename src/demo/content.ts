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
  notes: { title: string; tags: string[]; body: string }[];
}

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
        tags: ['baking'],
        body: 'Friday 18:00 feed starter. Saturday 08:00 mix, bulk until 50 percent bigger, shape, fridge overnight. Sunday bake from cold at 250 then 230.\n\nWinter: put the starter in the oven with the light on. See [[Market stall]].',
      },
      {
        title: 'Market stall',
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
        tags: ['thesis', 'river'],
        body: 'Six sites, three above and three below the farm outflow. Samples every Tuesday, plus after storms.\n\nQuestion: does the outflow raise nitrate? See [[Chapter 3 plan]].',
      },
      {
        title: 'Chapter 3 plan',
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
      'They asked for an example of a time I changed my mind because of data.',
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
        tags: ['career'],
        body: 'Goal: move from lab work to data analysis.\n\nStories: the [[Wend river survey]] analysis; [[Plotline]] with 64 users; keeping the March samples.',
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
        tags: ['reading', 'ideas'],
        body: 'Fewer projects at once. One long morning block. Write the next step before stopping.\n\nTwo projects now: [[Wend river survey]] and [[Plotline]].',
      },
    ],
  },
];
