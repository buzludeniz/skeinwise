// Word cues the No-AI engine looks for in your sentences. Plain lists, matched case-insensitively on word edges.

function cue(words: string[]): RegExp {
  return new RegExp(`\\b(?:${words.join('|')})\\b`, 'i');
}

/** You changed course: a note written before this may be out of date. */
export const CHANGE_CUES = cue([
  'changing my mind',
  'changed my mind',
  'decided',
  'no longer',
  'instead',
  'switch(?:ing|ed)? to',
  'mov(?:e|ing|ed) to',
]);

/** You turned from what you said before. Stronger than a decision, which may only confirm a note. */
export const TURN_CUES = cue([
  'changing my mind',
  'changed my mind',
  'no longer',
  'instead',
  'switch(?:ing|ed)? to',
  'mov(?:e|ing|ed) to',
]);

/** You settled something. */
export const DECISION_CUES = cue([
  'decided',
  'decision',
  'going with',
  'settled on',
  'we will use',
  "we'll use",
  'chose',
  'changing my mind',
  'changed my mind',
  'switch(?:ing|ed)? to',
  'mov(?:e|ing|ed) to',
]);

/** You found something out. */
export const FINDING_CUES = cue([
  'turns out',
  'turned out',
  'found',
  'learned',
  'learnt',
  'realised',
  'realized',
  'figured out',
  'the trick',
  'the answer',
  'works',
  'worked',
  'fixed',
  'solved',
  'decided',
  'settled on',
  'going with',
]);

/** You had an idea or a plan. */
export const IDEA_CUES = cue([
  'idea',
  'what if',
  'could try',
  'should try',
  'might try',
  'maybe (?:i|we) (?:could|should)',
  'plan to',
  'want to (?:build|make|try|write|start)',
  'next step',
  'one day',
]);

/** Spoken filler the Cleaned layer drops. */
export const FILLER = /\b(?:um+|uh+|erm+|you know|i mean|basically|literally)\b,?\s*/gi;

export function isQuestion(sentence: string): boolean {
  return /\?["')\]]*$/.test(sentence.trim());
}
