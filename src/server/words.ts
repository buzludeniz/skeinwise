// Small word statistics for the views that need them before the organiser has run: "similar" lookups, the words
// you return to, and the names you mention. Plain counting, no model.

const STOP = new Set(
  `a about above after again against all also am an and any are around as at back be because been before being below
  between both but by can could did do does doing done down during each even every few first for from further get gets
  got had has have having he her here hers herself him himself his how i if in into is it its itself just keep know let
  like make makes made many may me might more most much must my myself need needs new next no nor not now of off on
  once one only or other our ours ourselves out over own per put really right same say says see seems set she should
  so some still such sure take than that the their theirs them themselves then there these they thing things think this
  those though through to too two under until up upon us use used using very want was way we well went were what when
  where which while who whom why will with without would yes yet you your yours yourself yourselves ok okay let's i'm
  it's don't can't won't that's there's here's what's i've i'll i'd we're they're you're isn't doesn't didn't
  three four five six seven eight nine ten twelve twenty hundred thousand half wants wanted lot lots bit maybe
  something anything everything nothing day days week weeks month months year years hour hours minute minutes time
  times today yesterday tomorrow`.split(/\s+/),
);

/** Lower-case words of three or more letters, minus common words. */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}][\p{L}\p{N}'_-]*[\p{L}\p{N}]|[\p{L}]{3,}/gu) ?? []).filter(
    (w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w),
  );
}

/** The most telling words of a text, for a "similar entries" search: longest first, at most `max`. */
export function keyWords(text: string, max = 6): string[] {
  const seen = new Set<string>();
  for (const w of words(text)) if (w.length >= 4 && !w.includes("'")) seen.add(w);
  return [...seen].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, max);
}

const NOT_NAMES = new Set(
  `The This That These Those There Then When What Where Which Who Why How And But For Not Yes No Our Your Their Its Let
  Can Could Should Would Will Here Now Today Tomorrow Yesterday Monday Tuesday Wednesday Thursday Friday Saturday Sunday
  January February March April May June July August September October November December Decided Changing Morning
  Picked Wrote Short Add Write Sort Fix Keep Make Take Use Give Try Maybe Also Still Just Some Every Each Any One Two
  Three Four Five Six Seven Eight Nine Ten First Next Last Done Okay Thanks Please Sure Great Good`.split(/\s+/),
);

/**
 * Capitalised words that are not at the start of a sentence: a rough reading of the names a text mentions
 * (people, places and projects alike).
 */
export function names(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?<![.!?:]\s|^|\n|["'(\[])\b([A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})?)\b/g)) {
    const name = m[1]!;
    if (!NOT_NAMES.has(name.split(' ')[0]!)) found.push(name);
  }
  return found;
}
