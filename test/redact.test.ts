import { describe, expect, it } from 'vitest';
import { Redactor, scrubSecrets } from '../src/organiser/redact.ts';

// Probes from the security audit (supply/07 part B, the wire proof of concept part 1). Every value is made up.
const DEPLOY = [
  'Shipping the staging box today. Mail me at sam.lee@example.com if it breaks.',
  'AWS creds for the deploy script: AKIAIOSFODNN7EXAMPLE / wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'GitHub token for CI: ghp_isqNu93aeRf0oaq2WOsxvMTVBmzT9FJGWTtB',
  'Anthropic key I pasted into the chat: sk-ant-api03-cda7c9c678b7de77a0c61cc623ff99fc0f478f0f9989d2e399fa054e0e0b',
  'DB url: postgres://admin:Hunter2-not-real@10.0.4.17:5432/prod',
  'SSH: ssh -i /Users/sam/.ssh/id_ed25519 deploy@203.0.113.9',
  'Card on file for the cloud bill: 4111 1111 1111 1111 exp 04/29 cvv 123',
  'SIN for the payroll form: 046-454-286',
  '',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

const SECRETS = [
  'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI/K7MDENG',
  'ghp_isqNu93aeRf0oaq2WOsxvMTVBmzT9FJGWTtB',
  'sk-ant-api03-',
  'Hunter2-not-real',
  '10.0.4.17',
  '/Users/sam/.ssh/id_ed25519',
  '4111 1111 1111 1111',
  '046-454-286',
  'BEGIN OPENSSH PRIVATE KEY',
  'b3BlbnNzaC1rZXktdjEA',
  'cvv 123',
];

describe('secrets', () => {
  it('replaces keys, tokens, passwords, cards, ID numbers, private addresses and home paths', () => {
    const out = new Redactor([]).redact(DEPLOY);
    for (const s of SECRETS) expect(out, s).not.toContain(s);
    expect(out).not.toContain('Hunter2');
    expect(out).toContain('[SECRET_');
    expect(out).toContain('postgres://admin:[SECRET_');
    expect(out).toContain('GitHub token for CI: [SECRET_');
  });

  it('replaces secrets even when redaction of personal details is off', () => {
    const r = new Redactor(['Sam Lee'], { personal: false });
    const out = r.redact(DEPLOY);
    for (const s of SECRETS) expect(out, s).not.toContain(s);
    expect(out).toContain('sam.lee@example.com');
    expect(r.restore(out)).toBe(DEPLOY);
  });

  it('catches the other common key and token shapes', () => {
    const r = new Redactor([], { personal: false });
    const samples = [
      'sk-proj-AbCdEf0123456789AbCdEf0123456789',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234567890-abcdefghij',
      'AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'sk_live_0123456789abcdefABCDEF',
      'hf_abcdefghijklmnopqrstuvwxyz0123456789',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
    ];
    for (const s of samples) expect(r.redact(`value: ${s} end`), s).not.toContain(s);
  });

  it('replaces only the value of a labelled pair', () => {
    const r = new Redactor([], { personal: false });
    expect(r.redact('password=Pa55w0rd! and api_key: "abc123def456"')).toBe('password=[SECRET_1] and api_key: "[SECRET_2]"');
    expect(r.redact('AWS_SECRET_ACCESS_KEY=abcd1234')).toBe('AWS_SECRET_ACCESS_KEY=[SECRET_3]');
    expect(r.redact('my password is hunter2.')).toBe('my password is [SECRET_4].');
    expect(r.redact('Authorization: Bearer abcdef0123456789xyz')).toBe('Authorization: Bearer [SECRET_5]');
    expect(r.redact('IBAN GB82 WEST 1234 5698 7654 32 on the first')).toBe('IBAN [SECRET_6] on the first');
    expect(r.redact('SSN 078-05-1120, PIN: 4521')).toBe('SSN [SECRET_8], PIN: [SECRET_7]');
    expect(r.redact('hosts 192.168.1.20, 172.16.0.3 and 100.100.1.1')).toBe('hosts [SECRET_9], [SECRET_10] and [SECRET_11]');
    expect(r.redact('C:\\Users\\sam\\Documents\\taxes.pdf and /home/alex/notes')).toBe('[SECRET_12] and [SECRET_13]');
  });

  it('leaves look-alikes alone', () => {
    const r = new Redactor([], { personal: false });
    const text = [
      'commit 9fceb02d0ae598e95dc970b74767f19372d61af8 on main',
      'card-like but fails Luhn: 4111 1111 1111 1112',
      'public host 203.0.113.9 and version 10.0.4',
      'see https://example.com/home/page and the token for CI',
      'pin the poster, keep the secret quiet',
    ].join('\n');
    expect(r.redact(text)).toBe(text);
  });
});

describe('personal details', () => {
  // [id, text, what must not be sent]
  const probes: [string, string, string][] = [
    ['date-then-phone', 'Notes from the call on 2024-03-01 020 7946 0958 was the number she gave me for the landlord.', '020 7946 0958'],
    ['seven-digit-local', 'Her direct line is 555-0134 and the office says to call before noon.', '555-0134'],
    ['slash-phone', 'My German mobile is 0171/1234567 in case anyone from the clinic needs me.', '0171/1234567'],
    ['spelled-email', 'Write to maria dot lopez at gmail dot com if the form bounces again.', 'maria dot lopez at gmail dot com'],
    ['numeric-street', 'The new flat is at 350 5th Avenue, New York, and the movers come on the twelfth.', '350 5th Avenue'],
    ['lowercase-street', 'Send the keys to 10 downing street, flat 4, postcode SW1A 2AA, and tell the porter.', '10 downing street'],
    ['non-english-address', 'Mon adresse est 12 rue de la Paix, 75002 Paris, et le code est 4521B.', '12 rue de la Paix'],
    ['german-address', 'Wir wohnen jetzt in der Hauptstraße 5 in Berlin.', 'Hauptstraße 5'],
    ['postcode', 'Billing postcode is SW1A 2AA and the delivery postcode is M1 1AE.', 'M1 1AE'],
    ['plural-health', 'The scans show the cancers have not spread.', 'cancers'],
    ['drug-names', 'Started sertraline 50mg and lithium last week.', 'sertraline'],
    ['mental-health', 'I have had suicidal thoughts and some self-harm since the anorexia came back.', 'suicidal'],
    ['hiv-hyphen', 'My HIV-positive result came back.', 'HIV'],
    ['name-accent', 'Dr. María López said the results look fine.', 'María López'],
    ['name-first-only', 'Maria said the landlord will not return the deposit.', 'Maria'],
    ['ssn', 'For the US tax form my social security number is 078-05-1120.', '078-05-1120'],
    ['passport', 'Passport number 533380006, issued in London.', '533380006'],
  ];

  it.each(probes)('%s', (_id, text, needle) => {
    const r = new Redactor(['Maria Lopez']);
    const out = r.redact(text);
    expect(out).not.toContain(needle);
    expect(r.restore(out)).toBe(text);
  });

  it('catches every part of the spelled-out email and each health word', () => {
    const out = new Redactor([]).redact('I have had suicidal thoughts and some self-harm since the anorexia came back.');
    expect(out).toBe('I have had [HEALTH_1] thoughts and some [HEALTH_2] since the [HEALTH_3] came back.');
  });

  it('keeps ordinary prose', () => {
    const text = 'I walked 3 miles down the road, then 2 people on the street said the 5 minutes walk was fine. Spring 2024 was busy; meet at noon.';
    expect(new Redactor(['Maria Lopez']).redact(text)).toBe(text);
  });

  it("matches a name's parts only when capitalised, and the whole name in any case", () => {
    const r = new Redactor(['Will Smith']);
    expect(r.redact('I will call Will; will smith come? WILL SMITH did.')).toBe('I will call [NAME_1]; [NAME_2] come? [NAME_3] did.');
  });
});

describe('scrubSecrets', () => {
  it('removes the given key and anything shaped like a secret', () => {
    expect(scrubSecrets('echo: key k-123-abc and ghp_isqNu93aeRf0oaq2WOsxvMTVBmzT9FJGWTtB', ['k-123-abc'])).toBe('echo: key *** and [SECRET_1]');
    expect(scrubSecrets('nothing here', [null, undefined, ''])).toBe('nothing here');
  });
});
