// The assistant's No-AI cues. A to-do is something you said you'd do; a promise is one someone is waiting on; a wait
// is the other way round, someone owes you; a reminder is a "remind me to". Like the organiser's cues
// (src/organiser/cues.ts) they are plain phrase lists, matched case-blind on whole words, so the reason a sentence was
// picked can always be read off a list. The assistant reads only your own words, never a model's or another person's.

function cue(phrases: string[]): RegExp {
  return new RegExp(`\\b(?:${phrases.join('|')})\\b`, 'i');
}

const I_WILL = "I(?:'ll| will| shall)";
const I_WOULD = "I(?:'d| would)";
const NAME = "[\\w'-]+";

export type LoopKind = 'promise' | 'todo' | 'waiting' | 'reminder';

/** Someone is waiting on you: you said you'd send, reply, call or pay. */
export const PROMISE_CUES = cue([
  `${I_WILL} (?:send|email|e-mail|mail|post|share|forward|reply|respond|write back|get back|follow up|call|ring|phone|text|message|ping|introduce|invite|pay|transfer|return|bring|drop off|review|look over|sign)`,
  `${I_WILL} let ${NAME} know`,
  'I promised',
  `I told ${NAME}(?: ${NAME})? ${I_WOULD}`,
  `I said ${I_WOULD}`,
  'I owe',
  'I agreed to',
  'I offered to',
  'I committed to',
]);

/** Something you mean to do. */
export const TODO_CUES = cue([
  'I (?:really |still |definitely |also |just )?(?:need|have|ought|plan|mean|intend) to',
  "I(?:'ve| have) got to",
  "I(?:'m| am) (?:going|planning) to",
  'I must',
  'I should',
  'I gotta',
  "(?:don't|do not) forget to",
  'I must remember to',
]);

/** A to-do written as a mark rather than a sentence: "TODO: …", "Next step: …", or an unticked "[ ]" list item. */
export const TODO_MARK = /^(?:\[ \]\s*|(?:todo|to-do|action item|next step)\s*:\s*)/i;

/** A ticked "[x]" list item: done. */
export const DONE_MARK = /^\[[xX]\]\s*/;

/** Someone owes you: you are waiting to hear back. */
export const WAITING_CUES = cue([
  "(?:I'm|I am|I'm still|I am still|still) waiting (?:on|for)",
  'waiting to hear (?:back )?from',
  "(?:haven't|have not|hasn't|has not|didn't|did not) hear(?:d)? back",
  'no (?:reply|answer|word) (?:yet )?from',
  `${NAME} (?:owes|promised) me`,
  `${NAME} (?:said|told me) (?:she|he|they)(?:'d| would| will|'ll)`,
]);

/** You asked to be reminded. */
export const REMINDER_CUES = cue(['remind me (?:to|about|that)', '(?:set|add) a reminder', 'note to self']);

/** Wording that looks like a loop but isn't one: the past, an "if", or something you no longer need to do. */
export const NOT_LOOP_CUES = cue([
  "I (?:should|must|would|could|might)(?:'ve| have)",
  "I (?:needed|had|wanted|planned|meant|intended) to",
  "if I(?:'ll| will| need| have| must| should)",
  'whether I',
  "I (?:don't|do not|no longer) (?:need|have) to",
  "I(?:'m| am) not (?:going|planning) to",
  'I should (?:say|mention|add|note|point out|clarify|explain)',
]);

/**
 * In a chat, "I'll send you", "I'll share it with you" and the like are said to the assistant, not to a person who is
 * waiting, so they don't count.
 */
export const TO_ASSISTANT_CUES = cue([
  "(?:send|show|give|paste|share|tell|forward|upload|attach)(?: it| them| this| that)?(?: with)? you",
  'let you know',
  'get back to you',
  'your (?:help|answer|reply|code|suggestion)',
]);

/** A later sentence that says a loop is closed. */
export const DONE_CUES = cue([
  'done',
  'finished',
  'sent',
  'submitted',
  'replied',
  'responded',
  'called',
  'rang',
  'emailed',
  'mailed',
  'texted',
  'messaged',
  'shipped',
  'fixed',
  'booked',
  'paid',
  'returned',
  'delivered',
  'signed',
  'posted',
  'handed (?:in|over)',
  'wrapped up',
  'sorted',
  'took care of',
  'dealt with',
  'crossed off',
  'completed',
  'followed up',
  'got back to',
  'heard back',
  'got (?:the|her|his|their|a) (?:reply|answer)',
]);

/** A "not" that turns a done cue around: "I still haven't sent it". */
export const NEGATION = /\b(?:not|never|still|yet)\b|n't\b/i;

/** The words in front of a to-do that a task title leaves out: "I need to", "remind me to", "TODO:". */
export const LEAD_IN = new RegExp(
  '^(?:' +
    [
      "I(?:'ll| will| shall)",
      "I (?:really |still |definitely |also |just )?(?:need|have|ought|plan|mean|intend) to",
      "I(?:'ve| have) got to",
      "I(?:'m| am) (?:going|planning) to",
      'I must(?: remember to)?',
      'I should',
      'I gotta',
      "(?:don't|do not) forget to",
      '(?:please )?remind me (?:to|about|that)',
      'note to self:?',
      '\\[ \\]',
      '(?:todo|to-do|action item|next step)\\s*:',
    ].join('|') +
    ')\\s*',
  'i',
);

/** Straight apostrophes, so "I’ll" and "I'll" read the same. */
export function plain(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'");
}

/** The kind of loop a sentence of yours opens, or null. Questions, the past and "if" sentences open none. */
export function loopKind(sentence: string, inChat: boolean): LoopKind | null {
  const s = plain(sentence).trim();
  if (s.length < 8 || s.length > 280 || /\?["')\]]*$/.test(s)) return null;
  if (DONE_MARK.test(s)) return null;
  if (REMINDER_CUES.test(s)) return 'reminder';
  if (TODO_MARK.test(s)) return 'todo';
  if (NOT_LOOP_CUES.test(s)) return null;
  if (WAITING_CUES.test(s)) return 'waiting';
  if (PROMISE_CUES.test(s)) return inChat && TO_ASSISTANT_CUES.test(s) ? null : 'promise';
  if (TODO_CUES.test(s)) return inChat && TO_ASSISTANT_CUES.test(s) ? null : 'todo';
  return null;
}

/** Whether a sentence of yours says something is done. A sentence that opens a loop closes none. */
export function saysDone(sentence: string): boolean {
  const s = plain(sentence).trim();
  if (DONE_MARK.test(s)) return true;
  return DONE_CUES.test(s) && !NEGATION.test(s) && loopKind(s, false) === null;
}

const NOT_NAMES = new Set(
  'I Me My We Our You Your It The This That These Those A An And But Or Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December Today Tomorrow Tonight Next Last Everyone Everybody Someone Somebody'.split(
    ' ',
  ),
);

/** The person a loop is with, when the words name one: "send Ana", "waiting on Ben", "Cleo owes me". */
export function whoIn(sentence: string): string | null {
  const s = plain(sentence);
  const patterns = [
    /\b(?:send|email|e-mail|mail|call|ring|phone|text|message|ping|introduce|invite|pay|tell|told|let|with|to|from|on|for|owe)\s+([A-Z][\p{L}'-]+)/gu,
    /(?:^|[.;,]\s*)([A-Z][\p{L}'-]+)\s+(?:owes|promised|said|told)\b/gu,
  ];
  let best: { at: number; name: string } | null = null;
  for (const re of patterns) {
    for (const m of s.matchAll(re)) {
      const name = m[1]!.replace(/'s$/, '');
      if (NOT_NAMES.has(name)) continue;
      const at = m.index + m[0].indexOf(m[1]!);
      if (!best || at < best.at) best = { at, name };
    }
  }
  return best?.name ?? null;
}

/** A task title from a loop's sentence: the lead-in dropped, the first letter raised, the closing stop gone. */
export function taskTitle(sentence: string): string {
  const s = plain(sentence).trim().replace(LEAD_IN, '').replace(/[.!;:,\s]+$/, '').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : '';
}
