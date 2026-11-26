import { describe, expect, it } from 'vitest';
import { loopKind, saysDone, taskTitle, whoIn } from '../../src/pa/cues.ts';
import { readWhen, whenAt, withoutWhen } from '../../src/pa/when.ts';

describe('loopKind', () => {
  it('reads promises, to-dos, waits and reminders in your words', () => {
    expect(loopKind("I'll send Ana the river report by Friday.", false)).toBe('promise');
    expect(loopKind('I’ll get back to Ben about the stall fee', false)).toBe('promise');
    expect(loopKind('I told Cleo I would review her chapter.', false)).toBe('promise');
    expect(loopKind('I promised Dad a call this weekend.', false)).toBe('promise');
    expect(loopKind('I need to renew the van insurance.', false)).toBe('todo');
    expect(loopKind('I still have to book the kiln slot', false)).toBe('todo');
    expect(loopKind("Don't forget to water the starter.", false)).toBe('todo');
    expect(loopKind('TODO: move the backups to the new disk', false)).toBe('todo');
    expect(loopKind('[ ] order more rye flour', false)).toBe('todo');
    expect(loopKind("I'm still waiting on Ben for the invoice.", false)).toBe('waiting');
    expect(loopKind("Haven't heard back from the landlord.", false)).toBe('waiting');
    expect(loopKind('Cleo owes me the edited map.', false)).toBe('waiting');
    expect(loopKind('Remind me to call the vet on Monday.', false)).toBe('reminder');
  });

  it('leaves out questions, the past, "if" sentences and what is said to the assistant', () => {
    expect(loopKind('Should I send Ana the report?', false)).toBeNull();
    expect(loopKind('Do I need to renew the insurance?', false)).toBeNull();
    expect(loopKind('I should have sent it last week.', false)).toBeNull();
    expect(loopKind('I needed to rest after the market.', false)).toBeNull();
    expect(loopKind('If I need to, I can borrow the van.', false)).toBeNull();
    expect(loopKind("I don't need to renew it until March.", false)).toBeNull();
    expect(loopKind('[x] order more rye flour', false)).toBeNull();
    expect(loopKind("I'll send you the error log.", true)).toBeNull();
    expect(loopKind("I'll send you the error log.", false)).toBe('promise');
    expect(loopKind('I need to paste you the stack trace', true)).toBeNull();
    expect(loopKind('Sourdough is a slow craft.', false)).toBeNull();
    expect(loopKind('ok', false)).toBeNull();
  });
});

describe('saysDone', () => {
  it('knows a closing sentence, and not one that is still open', () => {
    expect(saysDone('Sent Ana the river report.')).toBe(true);
    expect(saysDone('Finally booked the kiln slot!')).toBe(true);
    expect(saysDone('[x] order more rye flour')).toBe(true);
    expect(saysDone("I still haven't sent the report.")).toBe(false);
    expect(saysDone("I'll send the report when it's done.")).toBe(false);
    expect(saysDone('The bread rose well.')).toBe(false);
  });
});

describe('whoIn and taskTitle', () => {
  it('names the person when the words do', () => {
    expect(whoIn("I'll send Ana the river report by Friday.")).toBe('Ana');
    expect(whoIn("I'm still waiting on Ben for the invoice.")).toBe('Ben');
    expect(whoIn('Cleo owes me the edited map.')).toBe('Cleo');
    expect(whoIn('I need to call on Monday.')).toBeNull();
    expect(whoIn('I need to renew the van insurance.')).toBeNull();
  });

  it('turns a sentence into a task title', () => {
    expect(taskTitle("I'll send Ana the river report by Friday.")).toBe('Send Ana the river report by Friday');
    expect(taskTitle('I really need to renew the van insurance.')).toBe('Renew the van insurance');
    expect(taskTitle('Remind me to call the vet.')).toBe('Call the vet');
    expect(taskTitle('TODO: move the backups')).toBe('Move the backups');
    expect(taskTitle('[ ] order more rye flour')).toBe('Order more rye flour');
  });
});

describe('readWhen', () => {
  // Wednesday 25 November 2026, 10:00 local time.
  const now = new Date(2026, 10, 25, 10, 0);
  const read = (text: string) => {
    const w = readWhen(text, now);
    return w && [w.day, w.time];
  };

  it('reads days', () => {
    expect(read('call Ana tomorrow')).toEqual(['2026-11-26', null]);
    expect(read('the day after tomorrow')).toEqual(['2026-11-27', null]);
    expect(read('send it by Friday')).toEqual(['2026-11-27', null]);
    expect(read('on Wednesday')).toEqual(['2026-12-02', null]);
    expect(read('next Monday')).toEqual(['2026-11-30', null]);
    expect(read('in 3 days')).toEqual(['2026-11-28', null]);
    expect(read('in two weeks')).toEqual(['2026-12-09', null]);
    expect(read('in a couple of days')).toEqual(['2026-11-27', null]);
    expect(read('by the end of the week')).toEqual(['2026-11-27', null]);
    expect(read('by end of month')).toEqual(['2026-11-30', null]);
    expect(read('next week')).toEqual(['2026-11-30', null]);
    expect(read('next month')).toEqual(['2026-12-01', null]);
    expect(read('this weekend')).toEqual(['2026-11-28', null]);
    expect(read('on 2026-12-03')).toEqual(['2026-12-03', null]);
    expect(read('on the 4th of December')).toEqual(['2026-12-04', null]);
    expect(read('by Dec 12th')).toEqual(['2026-12-12', null]);
    expect(read('on 3 March')).toEqual(['2027-03-03', null]);
    expect(read('today')).toEqual(['2026-11-25', null]);
  });

  it('reads times, with or without a day', () => {
    expect(read('tomorrow at 3')).toEqual(['2026-11-26', '15:00']);
    expect(read('tomorrow at 9')).toEqual(['2026-11-26', '09:00']);
    expect(read('Friday at 4:30pm')).toEqual(['2026-11-27', '16:30']);
    expect(read('at 14:15 on Monday')).toEqual(['2026-11-30', '14:15']);
    expect(read('tomorrow morning')).toEqual(['2026-11-26', '09:00']);
    expect(read('tonight')).toEqual(['2026-11-25', '20:00']);
    expect(read('at noon')).toEqual(['2026-11-25', '12:00']);
    expect(read('at 8am')).toEqual(['2026-11-26', '08:00']);
    expect(read('in 2 hours')).toEqual(['2026-11-25', '12:00']);
    expect(read('in 30 minutes')).toEqual(['2026-11-25', '10:30']);
  });

  it('finds no when in plain text, numbers or a "may"', () => {
    expect(readWhen('the river report', now)).toBeNull();
    expect(readWhen('I may come along', now)).toBeNull();
    expect(readWhen('we sold 3 loaves', now)).toBeNull();
    expect(readWhen('three times a day', now)).toBeNull();
  });

  it('keeps the words that said when, and can take them out', () => {
    expect(readWhen('Call Ana tomorrow at 3', now)?.phrase).toBe('tomorrow at 3');
    expect(withoutWhen('Call Ana tomorrow at 3', now)).toBe('Call Ana');
    expect(withoutWhen('Send the deck by Friday.', now)).toBe('Send the deck.');
    expect(withoutWhen('Pay rent on the 1st of December', now)).toBe('Pay rent');
    expect(withoutWhen('call the vet at noon on Friday', now)).toBe('call the vet');
    expect(withoutWhen('the river report', now)).toBe('the river report');
  });

  it('turns a when into a local moment', () => {
    expect(whenAt({ day: '2026-11-26', time: '15:00' })).toEqual(new Date(2026, 10, 26, 15, 0));
    expect(whenAt({ day: '2026-11-26', time: null })).toEqual(new Date(2026, 10, 26, 9, 0));
  });
});
