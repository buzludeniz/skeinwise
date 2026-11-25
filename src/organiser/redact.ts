// Redaction for text that leaves this computer. Emails, phone numbers, street addresses, health words and the names
// you list become placeholders like [NAME_1] before a request goes to a server elsewhere, and the placeholders in the
// answer are put back. One Redactor serves one request, so the same text always gets the same placeholder in it.
// The patterns are plain regular expressions: they catch the common shapes, not every way to write a person's details.

export type RedactionKind = 'EMAIL' | 'PHONE' | 'ADDRESS' | 'HEALTH' | 'NAME';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** A run of digits with the usual separators; it counts as a phone number with 9 to 15 digits. */
const PHONE = /(?<![\w+])\+?\d[\d\s().-]{6,}\d(?!\w)/g;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
const ADDRESS =
  /\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][A-Za-z'-]*\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct|Place|Pl|Square|Sq|Terrace|Close|Crescent|Parkway|Highway)\b/g;
const HEALTH_WORDS = [
  'diagnosis',
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
  'cancer',
  'tumou?r',
  'diabetes',
  'diabetic',
  'hiv',
  'asthma',
  'epilepsy',
  'migraines?',
  'chemotherapy',
  'surgery',
  'therapy',
  'therapist',
  'psychiatrist',
  'medication',
  'antidepressants?',
  'prescription',
  'pregnant',
  'pregnancy',
  'miscarriage',
  'rehab',
  'addiction',
];
const HEALTH = new RegExp(`\\b(?:${HEALTH_WORDS.join('|')})\\b`, 'gi');
const PLACEHOLDER = /\[(EMAIL|PHONE|ADDRESS|HEALTH|NAME)_(\d+)\]/g;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Redactor {
  private readonly names: RegExp | null;
  private readonly byText = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly counts = new Map<RedactionKind, number>();

  constructor(names: readonly string[]) {
    const list = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
    this.names = list.length ? new RegExp(`(?<![\\w])(?:${list.map(escape).join('|')})(?![\\w])`, 'gi') : null;
  }

  /** How many different pieces of text were replaced. */
  get size(): number {
    return this.byText.size;
  }

  redact(text: string): string {
    let out = text.replace(EMAIL, (m) => this.placeholder('EMAIL', m));
    out = out.replace(ADDRESS, (m) => this.placeholder('ADDRESS', m));
    out = out.replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, '').length;
      if (digits < 9 || digits > 15 || ISO_DATE.test(m)) return m;
      return this.placeholder('PHONE', m);
    });
    out = out.replace(HEALTH, (m) => this.placeholder('HEALTH', m));
    if (this.names) out = out.replace(this.names, (m) => this.placeholder('NAME', m));
    return out;
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
