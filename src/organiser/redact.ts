// Redaction for text that leaves this computer. Before a request goes to a server elsewhere, secrets and a person's
// details become placeholders like [SECRET_1] or [NAME_1], and the placeholders in the answer are put back. One
// Redactor serves one request, so the same text always gets the same placeholder in it.
//
// Two classes:
// - SECRET: keys and tokens (AWS, GitHub, Anthropic, OpenAI, Slack, Google, Stripe, Hugging Face and others), private
//   key blocks, JWTs, password and token pairs, passwords in URLs, card numbers (Luhn-checked), IBANs (checksum
//   checked), US social security and Canadian social insurance numbers, private IP addresses and home folder paths.
//   Always on for text that leaves the computer: the redaction setting does not turn it off.
// - Personal (the redaction setting): emails (also spelled out), phone numbers, street addresses and postcodes,
//   health words and medicines, and the names you list (with or without accents, and each part of a longer name).
//
// The patterns are plain regular expressions: they catch the common shapes, not every way to write a person's
// details. Names that aren't on your list, and many non-English addresses, still go through.

export type RedactionKind = 'SECRET' | 'EMAIL' | 'PHONE' | 'ADDRESS' | 'HEALTH' | 'NAME';

export interface RedactOptions {
  /** Whether a person's details (emails, phones, addresses, health words, names) are replaced too. Default true. */
  personal?: boolean;
}

// ---------------------------------------------------------------- secrets

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
/** scheme://user:password@host: only the password is replaced. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(?=@)/gi;
/** password=..., api_key: ..., AWS_SECRET_ACCESS_KEY=...: only the value is replaced. */
const LABELED =
  /\b([A-Za-z0-9_-]*(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?))(["']?\s*[:=]\s*["']?)(?!\[[A-Z]+_\d+\])([^\s"'`,;]*[^\s"'`,;.)\]])/gi;
/** "my password is ..." */
const SPOKEN = /\b((?:password|passcode|passphrase)\s+(?:is|was)\s+)(?!\[[A-Z]+_\d+\])([^\s"'`,;]*[^\s"'`,;.!?)\]])/gi;
/** "PIN: 4521", "cvv 123" */
const CODE = /\b((?:pin|cvv2?|cvc|csc)(?:\s+(?:is|was))?\s*[:=]?\s*)(\d{3,8})\b/gi;
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/-]{12,}=*)/g;
const TOKENS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI (sk-, sk-proj-) and Anthropic (sk-ant-)
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bnpm_[A-Za-z0-9]{36}/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, // JWT
];
/** A 40-character AWS-style secret: mixed case and a digit, so hex hashes don't count, and few slashes, so paths don't. */
const AWS_SECRET = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
/** 4111 1111 1111 1111, 3782 822463 10005, 4111111111111111: the usual groupings, so a date and a phone number don't. */
const CARD = /(?<![\d-])(?:\d{4}([ -]?)\d{4}\1\d{4}\1\d{1,7}|\d{4}[ -]?\d{6}[ -]?\d{4,5}|\d{13,19})(?![\d-]?\d)/g;
const SSN = /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g;
const SIN = /(?<![\d-])\d{3}[ -]\d{3}[ -]\d{3}(?![\d-])/g;
const PRIVATE_IP =
  /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?![\d.]*\d)/g;
const HOME_PATH = /(?:(?<![\w.-])\/(?:Users|home)\/[A-Za-z0-9._-]+|\b[A-Za-z]:\\Users\\[A-Za-z0-9._-]+)(?:[\\/][^\s"'`<>()[\]{},;]*)?/g;

// ---------------------------------------------------------------- a person's details

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const DOT = String.raw`(?:\s+dot\s+|\s*[[(]dot[\])]\s*)`;
const AT = String.raw`(?:\s+at\s+|\s*[[(]at[\])]\s*)`;
/** maria dot lopez at gmail dot com, maria(at)example(dot)org */
const SPELLED_EMAIL = new RegExp(String.raw`\b[A-Za-z0-9._%+-]+(?:${DOT}[A-Za-z0-9_%+-]+)*${AT}[A-Za-z0-9-]+(?:${DOT}[A-Za-z0-9-]+)+\b`, 'gi');

/** A run of digits with the usual separators; it counts as a phone number with 9 to 15 digits. */
const PHONE = /(?<![\w+])\+?\d[\d\s().-]{6,}\d(?!\w)/g;
const ISO_DATE = /(\d{4}-\d{2}-\d{2})/;
/** 555-0134 */
const SHORT_PHONE = /(?<![\w+./-])\d{3}-\d{4}(?![\w/]|[-.]\d)/g;
/** 0171/1234567 */
const SLASH_PHONE = /(?<![\w/])(?:\+|0)\d{1,4}\/\d{5,9}(?![\w/])/g;

const SUFFIX = 'Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct|Place|Pl|Square|Sq|Terrace|Close|Crescent|Parkway|Pkwy|Highway|Hwy|Mews|Gardens|Grove';
/** 12 Baker Street, 350 5th Avenue */
const ADDRESS = new RegExp(String.raw`\b\d{1,5}[A-Za-z]?\s+(?:(?:[A-Z][A-Za-z'-]*|\d+(?:st|nd|rd|th))\s+){1,3}(?:${SUFFIX})\b`, 'g');
const STOP =
  'the|a|an|on|in|at|of|to|for|and|or|but|my|our|your|his|her|their|its|down|up|from|by|with|into|onto|across|along|near|this|that|these|those|per|each|every|other|more|less|than|very|km|miles?|minutes?|mins?|hours?|metres?|meters?|feet|ft|yards?|blocks?|times?|days?|weeks?|years?';
/** 10 downing street: any case, but only the unmistakable street words, and no little words in the name. */
const ADDRESS_ANY_CASE = new RegExp(
  String.raw`\b\d{1,5}[a-z]?\s+(?:(?!(?:${STOP})\b)[a-z][a-z'-]*\s+){1,3}(?:street|avenue|road|lane|drive|boulevard|terrace|crescent|parkway|highway)\b`,
  'gi',
);
const LITTLE = String.raw`(?:de|du|des|la|le|les|del|della|delle|dei|di|da|dos|das|do|y|e|l'|d')`;
const NAME_WORD = String.raw`\p{Lu}[\p{L}'-]*`;
/** 12 rue de la Paix, 3 bis avenue Foch, 5 Calle de Alcalá */
const EUROPEAN_NUMBER_FIRST = new RegExp(
  String.raw`\b\d{1,5}(?:\s?(?:bis|ter))?,?\s+(?:[Rr]ue|[Aa]venue|[Bb]oulevard|[Bb]d|[Pp]lace|[Cc]hemin|[Aa]llée|[Ii]mpasse|[Qq]uai|[Vv]ia|[Vv]iale|[Pp]iazza|[Cc]orso|[Cc]alle|[Aa]venida|[Pp]laza|[Pp]aseo|[Cc]arrer|[Rr]ua|[Tt]ravessa|[Ll]argo)\s+(?:${LITTLE}\s*)*${NAME_WORD}(?:\s+${NAME_WORD}){0,3}`,
  'gu',
);
/** Via Roma 12, Calle Mayor 5 */
const EUROPEAN_NUMBER_LAST = new RegExp(
  String.raw`\b(?:Rue|Via|Viale|Piazza|Corso|Calle|Avenida|Plaza|Paseo|Carrer|Rua)\s+(?:${LITTLE}\s*)*${NAME_WORD}(?:\s+${NAME_WORD}){0,3},?\s+\d{1,5}[a-z]?\b`,
  'gu',
);
/** Hauptstraße 5, Berliner Straße 12a, Keizersgracht 123 */
const GERMANIC = new RegExp(
  String.raw`(?<![\p{L}\p{N}])${NAME_WORD}(?:\s+(?:Straße|Strasse|Str\.|Weg|Gasse|Platz|Allee|Damm)|(?:straße|strasse|str\.|weg|gasse|platz|allee|damm|ufer|straat|laan|gracht|plein|steeg|gade|gatan|vägen))\s+\d{1,4}[a-z]?\b`,
  'gu',
);
/** UK (SW1A 2AA, M1 1AE) and Canadian (K1A 0B1) postcodes. */
const POSTCODE = /\b(?:[A-Z]{1,2}\d[A-Z\d]?\s?\d[ABD-HJLNP-UW-Z]{2}|[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d)\b/g;

const HEALTH_WORDS = [
  'diagnos[ie]s',
  'diagnosed',
  'depression',
  'depressed',
  'anxiety',
  'panic attacks?',
  'adhd',
  'autism',
  'autistic',
  'bipolar',
  'ocd',
  'ptsd',
  'insomnia',
  'cancers?',
  'cancerous',
  'tumou?rs?',
  'oncologists?',
  'oncology',
  'biops(?:y|ies)',
  'mastectomy',
  'chemo(?:therapy)?',
  'radiotherapy',
  'diabetes',
  'diabetic',
  'hiv',
  'aids-related',
  'hepatitis',
  'herpes',
  'chlamydia',
  'gonorrho?ea',
  'syphilis',
  'stis?',
  'stds?',
  'asthma',
  'epilepsy',
  'epileptic',
  'seizures?',
  'migraines?',
  'fibromyalgia',
  'endometriosis',
  "crohn's",
  'colitis',
  'multiple sclerosis',
  "alzheimer'?s",
  "parkinson'?s",
  'dementia',
  'schizophreni(?:a|c)',
  'psychosis',
  'psychotic',
  'suicid(?:e|al)',
  'self[- ]harm(?:ing)?',
  'overdosed?',
  'anorexi(?:a|c)',
  'bulimi(?:a|c)',
  'eating disorders?',
  'alcoholism',
  'alcoholic',
  'detox',
  'surger(?:y|ies)',
  'therap(?:y|ies)',
  'therapists?',
  'psychiatrists?',
  'psychologists?',
  'counsell?(?:ing|or)',
  'mental (?:health|illness)',
  'hospitali[sz]ed',
  'medications?',
  'antidepressants?',
  'antipsychotics?',
  'prescriptions?',
  'pregnant',
  'pregnanc(?:y|ies)',
  'miscarriages?',
  'abortions?',
  'ivf',
  'infertil(?:e|ity)',
  'rehab',
  'addiction',
  // Medicines that say what a person is treated for.
  'sertraline',
  'fluoxetine',
  'citalopram',
  'escitalopram',
  'paroxetine',
  'venlafaxine',
  'duloxetine',
  'bupropion',
  'mirtazapine',
  'prozac',
  'zoloft',
  'lexapro',
  'wellbutrin',
  'lithium',
  'lamotrigine',
  'valproate',
  'quetiapine',
  'olanzapine',
  'risperidone',
  'aripiprazole',
  'clozapine',
  'methylphenidate',
  'ritalin',
  'adderall',
  'lisdexamfetamine',
  'diazepam',
  'lorazepam',
  'alprazolam',
  'xanax',
  'clonazepam',
  'naltrexone',
  'methadone',
  'buprenorphine',
  'suboxone',
  'truvada',
  'insulin',
  'metformin',
  'levothyroxine',
  'semaglutide',
  'ozempic',
  'wegovy',
];
const HEALTH = new RegExp(`\\b(?:${HEALTH_WORDS.join('|')})\\b`, 'gi');

const PLACEHOLDER = /\[(SECRET|EMAIL|PHONE|ADDRESS|HEALTH|NAME)_(\d+)\]/g;

// ---------------------------------------------------------------- names

/** Letters a name may be written with, with or without its accents. */
const FOLD: Record<string, string> = {
  a: 'aàáâãäåāăą',
  c: 'cçćĉċč',
  d: 'dďđ',
  e: 'eèéêëēĕėęě',
  g: 'gĝğġģ',
  i: 'iìíîïĩīĭįı',
  l: 'lĺļľł',
  n: 'nñńņň',
  o: 'oòóôõöøōŏő',
  r: 'rŕŗř',
  s: 'sśŝşšș',
  t: 'tţťț',
  u: 'uùúûüũūŭůűų',
  y: 'yýÿŷ',
  z: 'zźżž',
};
/** Small words in names that alone say nothing about the person. */
const PARTICLES = new Set(['de', 'del', 'della', 'der', 'den', 'van', 'von', 'la', 'le', 'da', 'di', 'do', 'dos', 'du', 'mc', 'mac', 'bin', 'ibn', 'al', 'el', 'the', 'and']);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function letters(ch: string, upperOnly: boolean): string {
  const base = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const lower = FOLD[base] ?? (base.length === 1 && /\p{L}/u.test(base) ? base : ch.toLowerCase());
  const upper = lower.toUpperCase();
  const set = [...new Set([...(upperOnly ? upper : lower + upper)])].filter((c) => c.length === 1);
  return `[${set.map((c) => (/[\]\\^-]/.test(c) ? `\\${c}` : c)).join('')}]\\p{M}*`;
}

/** A pattern for a name, any case unless only its first letter capitalised counts. */
function namePattern(name: string, capitalised: boolean): string {
  let out = '';
  let first = true;
  for (const ch of name) {
    if (/\s/.test(ch)) {
      if (!out.endsWith('\\s+')) out += '\\s+';
      first = true;
    } else if (/\p{L}/u.test(ch)) {
      out += letters(ch, capitalised && first);
      first = false;
    } else if (ch === "'" || ch === '’') {
      out += "['’]";
    } else {
      out += escape(ch);
    }
  }
  return out;
}

function namesRegex(names: readonly string[]): RegExp | null {
  const full = [...new Set(names.map((n) => n.trim().replace(/\s+/g, ' ')).filter(Boolean))];
  const parts = new Set<string>();
  for (const name of full) {
    const words = name.split(' ');
    if (words.length < 2) continue;
    for (const w of words) {
      const bare = w.replace(/[.,]/g, '');
      if ([...bare].length >= 3 && !PARTICLES.has(bare.toLowerCase())) parts.add(bare);
    }
  }
  const entries = [...full.map((n) => ({ n, capitalised: false })), ...[...parts].filter((p) => !full.includes(p)).map((n) => ({ n, capitalised: true }))];
  if (!entries.length) return null;
  entries.sort((a, b) => b.n.length - a.n.length);
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${entries.map((e) => namePattern(e.n, e.capitalised)).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
}

// ---------------------------------------------------------------- checks

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanValid(text: string): boolean {
  const s = text.replace(/ /g, '');
  if (s.length < 15 || s.length > 34) return false;
  let rem = 0;
  for (const ch of s.slice(4) + s.slice(0, 4)) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

// ---------------------------------------------------------------- the redactor

export class Redactor {
  private readonly personal: boolean;
  private readonly names: RegExp | null;
  private readonly byText = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly counts = new Map<RedactionKind, number>();

  constructor(names: readonly string[], options: RedactOptions = {}) {
    this.personal = options.personal ?? true;
    this.names = this.personal ? namesRegex(names) : null;
  }

  /** How many different pieces of text were replaced. */
  get size(): number {
    return this.byText.size;
  }

  redact(text: string): string {
    const out = this.secrets(text);
    return this.personal ? this.details(out) : out;
  }

  /** Puts the original text back into every string of a parsed answer. */
  restore(value: unknown): unknown {
    if (typeof value === 'string') return value.replace(PLACEHOLDER, (m) => this.byPlaceholder.get(m) ?? m);
    if (Array.isArray(value)) return value.map((v) => this.restore(v));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.restore(v)]));
    }
    return value;
  }

  private secrets(text: string): string {
    const secret = (m: string) => this.placeholder('SECRET', m);
    let out = text.replace(PRIVATE_KEY_BLOCK, secret);
    out = out.replace(URL_PASSWORD, (_m, before: string, password: string) => before + secret(password));
    for (const re of TOKENS) out = out.replace(re, secret);
    out = out.replace(BEARER, (_m, before: string, token: string) => before + secret(token));
    out = out.replace(LABELED, (_m, label: string, sep: string, value: string) => label + sep + secret(value));
    out = out.replace(SPOKEN, (_m, label: string, value: string) => label + secret(value));
    out = out.replace(CODE, (_m, label: string, value: string) => label + secret(value));
    out = out.replace(AWS_SECRET, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) && (m.match(/\//g)?.length ?? 0) <= 3 ? secret(m) : m));
    out = out.replace(IBAN, (m) => {
      for (let end = m.length; end >= 15; end--) {
        if (end < m.length && m[end] !== ' ') continue;
        if (ibanValid(m.slice(0, end))) return secret(m.slice(0, end)) + m.slice(end);
      }
      return m;
    });
    out = out.replace(CARD, (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? secret(m) : m;
    });
    out = out.replace(SSN, secret);
    out = out.replace(SIN, (m) => (luhn(m.replace(/\D/g, '')) ? secret(m) : m));
    out = out.replace(PRIVATE_IP, secret);
    out = out.replace(HOME_PATH, secret);
    return out;
  }

  private details(text: string): string {
    let out = text.replace(EMAIL, (m) => this.placeholder('EMAIL', m));
    out = out.replace(SPELLED_EMAIL, (m) => this.placeholder('EMAIL', m));
    for (const re of [ADDRESS, ADDRESS_ANY_CASE, EUROPEAN_NUMBER_FIRST, EUROPEAN_NUMBER_LAST, GERMANIC, POSTCODE]) {
      out = out.replace(re, (m) => this.placeholder('ADDRESS', m));
    }
    out = out.replace(SLASH_PHONE, (m) => this.placeholder('PHONE', m));
    out = this.phones(out);
    out = out.replace(SHORT_PHONE, (m) => this.placeholder('PHONE', m));
    out = out.replace(HEALTH, (m) => this.placeholder('HEALTH', m));
    if (this.names) out = out.replace(this.names, (m) => this.placeholder('NAME', m));
    return out;
  }

  /** Phone numbers, with a date written just before one (2024-03-01 020 7946 0958) kept apart from it. */
  private phones(text: string): string {
    return text.replace(PHONE, (m) => {
      if (ISO_DATE.test(m)) {
        return m
          .split(ISO_DATE)
          .map((part, i) => (i % 2 ? part : this.phones(part)))
          .join('');
      }
      const digits = m.replace(/\D/g, '').length;
      if (digits < 9 || digits > 15) return m;
      return this.placeholder('PHONE', m);
    });
  }

  private placeholder(kind: RedactionKind, text: string): string {
    const known = this.byText.get(text);
    if (known) return known;
    const n = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, n);
    const p = `[${kind}_${n}]`;
    this.byText.set(text, p);
    this.byPlaceholder.set(p, text);
    return p;
  }
}

/**
 * Text that is safe to show or store: each of the given values (an API key) becomes ***, and anything shaped like a
 * secret becomes a placeholder. For error messages and run notes that may hold what a server echoed back.
 */
export function scrubSecrets(text: string, values: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const v of values) if (v) out = out.split(v).join('***');
  return new Redactor([], { personal: false }).redact(out);
}
