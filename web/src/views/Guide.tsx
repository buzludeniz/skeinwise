// "Reading your brain": what the points, places, colours and lines mean, in short plain paragraphs.

import { closePanel } from '../actions.ts';
import { useApp } from '../store.ts';
import { MOD, SidePanel } from '../ui/common.tsx';

const LINES: [string, string, boolean][] = [
  ['Thread line', 'Joins the messages of one conversation, in the order they were said.', true],
  ['Cross link', 'Joins two entries in different threads that read alike. The organiser finds them.', true],
  ['Note link', 'A [[link]] you wrote in a note. It arcs between the two notes.', true],
  ['Hub spoke', 'Joins a hub to each entry it holds. Faint until you light the entries.', true],
  ['Time chain', 'Joins entries in date order, so you can follow a day or a week.', false],
  ['Label spark', 'Flashes from a label to its points while you hover the label.', false],
  ['Label leader', 'Holds a label close to the point it names.', true],
];

export function GuidePanel() {
  const hubs = useApp((s) => s.organiser.hubs.length);
  return (
    <SidePanel title="Reading your brain" label="Reading your brain" onClose={closePanel}>
      <div class="prose guide-panel">
        <h3>Hubs</h3>
        <p>
          Hubs are the large labelled points. Each one stands for an idea the organiser found across many entries, and
          a faint spoke joins it to each of them. Double-click a hub to read what it found.
          {hubs ? '' : ' There are none yet: run the organiser to make hubs.'}
        </p>
        <h3>The body</h3>
        <p>
          The notes you wrote and the hubs sit in the head's two lobes. Every other entry, your messages and files,
          hangs on its source's nerve: chat assistants run down the arms, coding agents down the legs, and other sources
          round the trunk.
        </p>
        <p>
          The cord down the back is the calendar, with a ring at the edge of each month and this month at the top. A run
          of empty months folds into one fainter ring. Along every nerve, time runs from its root at the cord, the
          oldest, to its tip, today. A nerve that stops short shows when its source went quiet, and a faint one drawn
          all the way has nothing in it yet. Framing brings the camera to the whole body, the head or the cord.
        </p>
        <h3>Clusters</h3>
        <p>Points close together have something in common: the same thread, the same group, or links between them.</p>
        <h3>The index</h3>
        <p>
          Search reads every word in the record, not only titles, and ranks your own words a little above the
          assistants'. Press {MOD}K to search or ask a question.
        </p>
        <h3>Colour and labels</h3>
        <p>
          Colour shows one grouping at a time: project, folder, source or speaker. Change it in the legend at the foot
          of the brain, and click a group to show it alone. Labels name the hubs first, then the most-linked notes; they
          hide when they would crowd each other or sit behind the cloud.
        </p>
        <h3>The lines</h3>
        <dl class="line-list">
          {LINES.map(([name, text, drawn]) => (
            <div key={name}>
              <dt>
                {name}
                {!drawn && <span class="tag">Later</span>}
              </dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
        <p class="soft">Lines marked Later are not drawn yet.</p>
      </div>
    </SidePanel>
  );
}
