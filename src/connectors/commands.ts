// The connector commands: connect, connections and disconnect. The CLI wires CONNECTOR_COMMANDS into its command table
// and CONNECTOR_FLAGS into its parser; each command takes the same Ctx as the organiser's. A client secret or a Slack
// token comes from a hidden prompt or a file (--client-secret-file, --token-file), never from a flag's value, which
// would sit in the shell's history, and goes straight into the Keychain.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { Io } from '../cli.ts';
import type { Ctx } from '../cli-organiser.ts';
import { UsageError } from '../errors.ts';
import { day } from '../format.ts';
import type { Keychain } from './keychain.ts';
import { keychainItems } from './keychain.ts';
import { signIn } from './oauth.ts';
import {
  apiFor,
  CONNECTORS,
  type ConnectorDeps,
  credentials,
  depsFrom,
  POLL_MINUTES,
  pollConnectors,
  relative,
  sourceFor,
  supported,
} from './poll.ts';
import { resolveChannels } from './slack.ts';
import { type Connection, findConnection, loadConnections, putConnection } from './state.ts';
import { ConnectorError, isService, SERVICES, type Client, type Connector, type ServiceName, type Token } from './types.ts';

type Command = (ctx: Ctx) => number | Promise<number>;

/** The flags these commands read, for the CLI's parseArgs options (--from, --yes and --json it has already). */
export const CONNECTOR_FLAGS = {
  'client-id': { type: 'string' },
  'client-secret-file': { type: 'string' },
  'token-file': { type: 'string' },
  channels: { type: 'string' },
  calendars: { type: 'string' },
  port: { type: 'string' },
  keep: { type: 'boolean' },
  drop: { type: 'boolean' },
  pull: { type: 'boolean' },
} as const;

interface ConnectorValues {
  json?: boolean;
  yes?: boolean;
  from?: string;
  'client-id'?: string;
  'client-secret-file'?: string;
  'token-file'?: string;
  channels?: string;
  calendars?: string;
  port?: string;
  keep?: boolean;
  drop?: boolean;
  pull?: boolean;
}

export const CONNECTOR_HELP = `Connectors (read-only; tokens stay in the macOS Keychain; how to set each up: docs/connectors.md):
  connect <service>         Connect gmail, calendar, todoist or slack: shows what it reads and the
                            permissions it asks for, signs in, then pulls what is there
      --client-id <id>      Your own OAuth client's ID (Gmail, Calendar, Todoist)
      --client-secret-file <file>  Read your client's secret from a file instead of asking
      --token-file <file>   Read Slack's User OAuth Token from a file instead of asking
      --channels <names>    The Slack channels to read, comma-separated
      --calendars <ids>     The calendars to read (default: your main one)
      --from <date>         How far back the first pull reaches (default: 90 days ago)
      --port <port>         The loopback port your Todoist app has as its redirect (default 8735)
      --yes                 Go ahead without asking
  connections               What is connected, when it last pulled and how that went
      --pull                Pull every connection now
  disconnect <service>      Revoke the access, delete the token, and keep or leave out what was read
      --keep | --drop       Keep the items it read in search, or leave them out
`;

/** What tests (and only tests) replace: the prompts, the browser, the Keychain and the platform. */
export interface ConnectorIo extends Io {
  askSecret?: (prompt: string) => Promise<string | null>;
  openUrl?: (url: string) => Promise<void>;
  keychain?: Keychain;
  platform?: NodeJS.Platform;
}

const DEFAULT_DAYS = 90;

function deps(ctx: Ctx): ConnectorDeps {
  const io = ctx.io as ConnectorIo;
  return depsFrom({
    ...(io.fetch ? { fetch: io.fetch } : {}),
    ...(io.keychain ? { keychain: io.keychain } : {}),
    now: ctx.store.now,
    ...(io.platform ? { platform: io.platform } : {}),
  });
}

function values(ctx: Ctx): ConnectorValues {
  return ctx.values as ConnectorValues;
}

function serviceArg(ctx: Ctx, verb: string): ServiceName {
  const name = ctx.args[0]?.toLowerCase();
  if (!isService(name)) {
    throw new UsageError(`${verb} which service? One of: ${SERVICES.join(', ')}. For example: skeinwise ${verb.toLowerCase()} gmail`);
  }
  return name;
}

function notSupported(platform: NodeJS.Platform): UsageError {
  return new UsageError(
    `Connecting isn't supported on ${platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform} yet. Skeinwise keeps tokens in the macOS Keychain and has no equally safe place for them here, so it won't keep one.`,
  );
}

/** Asks on the terminal without showing what is typed. Null when there is no terminal to ask on. */
async function askHidden(prompt: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const stop = new AbortController();
  rl.on('SIGINT', () => stop.abort());
  try {
    const answer = rl.question(prompt, { signal: stop.signal }); // writes the prompt before returning
    muted = true;
    return await answer;
  } catch (err) {
    if (stop.signal.aborted) throw new UsageError('Stopped. Nothing was connected.');
    throw err;
  } finally {
    process.stderr.write('\n');
    rl.close();
  }
}

/** Opens the sign-in page in the default browser (macOS `open`). */
async function openInBrowser(url: string): Promise<void> {
  await new Promise<void>((done, fail) => {
    const child = spawn('/usr/bin/open', [url], { stdio: 'ignore' });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`open exited ${code}`))));
  });
}

function readSecretFile(path: string, what: string): string {
  let text: string;
  try {
    text = readFileSync(resolve(path), 'utf8');
  } catch {
    throw new UsageError(`Could not read the ${what} file ${path}.`);
  }
  return text.trim();
}

function listFlag(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function sinceFrom(value: string | undefined, now: string): string {
  if (!value) return new Date(Date.parse(now) - DEFAULT_DAYS * 86_400_000).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw new UsageError(`--from takes a date like 2026-09-01, not "${value}".`);
  if (value > now.slice(0, 10)) throw new UsageError(`--from ${value} is in the future.`);
  return new Date(`${value}T00:00:00Z`).toISOString();
}

/** What the person reads before any sign-in: what is read, each permission and why, where the token lives, how to stop. */
export function consentText(connector: Connector, home: string): string {
  const item = keychainItems(home, connector.service).token;
  const lines = [
    `Connect ${connector.label} (read-only)`,
    '',
    `Skeinwise will read ${connector.reads}.`,
    `It asks ${connector.label} for ${connector.scopes.length === 1 ? 'one permission' : `these ${connector.scopes.length} permissions`}:`,
    ...connector.scopes.map((s) => `  ${s.scope}\n      ${s.why}`),
    `It never sends, posts, deletes or changes anything in ${connector.label}, and never marks anything as read.`,
    `The token goes in your macOS Keychain (service "skeinwise", account "${item}"), never in a file or a log.`,
    `What it reads goes into this record only. To stop: skeinwise disconnect ${connector.service}`,
  ];
  return `${lines.join('\n')}\n`;
}

async function confirm(ctx: Ctx, question: string): Promise<void> {
  if (values(ctx).yes) return;
  const answer = ctx.io.ask ? await ctx.io.ask(question) : null;
  if (answer === null) throw new UsageError('There is no terminal to ask on. Read the above, then run the same command with --yes.');
  if (!/^y(es)?$/i.test(answer.trim())) throw new UsageError('Not connected. Nothing was saved.');
}

/** Gmail and Calendar can share one Google client: the other's ID is used when --client-id isn't given. */
function clientIdFor(ctx: Ctx, service: ServiceName): string | undefined {
  const given = values(ctx)['client-id']?.trim();
  if (given) return given;
  const all = loadConnections(ctx.home);
  const own = all.find((c) => c.service === service)?.clientId;
  if (own) return own;
  if (service === 'gmail' || service === 'calendar') return all.find((c) => (c.service === 'gmail' || c.service === 'calendar') && c.clientId)?.clientId;
  return undefined;
}

async function clientSecretFor(ctx: Ctx, connector: Connector, d: ConnectorDeps): Promise<string | undefined> {
  if (connector.signIn.kind !== 'oauth') return undefined;
  const file = values(ctx)['client-secret-file'];
  if (file) return readSecretFile(file, 'client secret') || undefined;
  // Reconnecting: the secret already in the Keychain.
  const kept = await d.keychain.get(keychainItems(ctx.home, connector.service).clientSecret);
  if (kept) return kept;
  const required = connector.signIn.provider.secret === 'required';
  const ask = (ctx.io as ConnectorIo).askSecret ?? askHidden;
  const answer = await ask(required ? `${connector.label} client secret: ` : `${connector.label} client secret (press Enter if your client has none): `);
  if (answer === null) {
    if (required) throw new UsageError('There is no terminal to ask on. Give the client secret in a file instead: --client-secret-file <file>');
    return undefined;
  }
  return answer.trim() || undefined;
}

async function pastedToken(ctx: Ctx, connector: Connector): Promise<Token> {
  const file = values(ctx)['token-file'];
  let text: string | null;
  if (file) text = readSecretFile(file, 'token');
  else text = await ((ctx.io as ConnectorIo).askSecret ?? askHidden)(`${connector.label} User OAuth Token (starts with xoxp-): `);
  if (text === null) throw new UsageError('There is no terminal to ask on. Give the token in a file instead: --token-file <file>');
  const token = text.trim();
  if (!token) throw new UsageError('No token given. Nothing was connected.');
  // A bot token (xoxb-) reads as the app, not as you, and can't see your private channels.
  if (!token.startsWith('xoxp-')) throw new UsageError("That isn't a User OAuth Token (those start with xoxp-). Copy the User OAuth Token from your app's OAuth & Permissions page. Nothing was connected.");
  return { access: token };
}

const connect: Command = async (ctx) => {
  const service = serviceArg(ctx, 'Connect');
  const connector = CONNECTORS[service];
  const d = deps(ctx);
  if (!supported(d.platform)) throw notSupported(d.platform);
  const v = values(ctx);
  const now = d.now();
  // With --json, standard output carries only the JSON; the words go to standard error.
  const say = (text: string) => (v.json ? ctx.io.err(text) : ctx.io.out(text));

  // Everything that can be wrong with the command stops it before the consent and the sign-in.
  const since = sinceFrom(v.from, now);
  let picks = connector.picks ? listFlag(v[connector.picks.flag as 'channels' | 'calendars']) : [];
  if (connector.picks && !picks.length) {
    if (!connector.picks.fallback) throw new UsageError(`Pick the ${connector.picks.what} to read: --${connector.picks.flag} <a,b>`);
    picks = connector.picks.fallback;
  }
  const clientId = connector.signIn.kind === 'oauth' ? clientIdFor(ctx, service) : undefined;
  if (connector.signIn.kind === 'oauth' && !clientId) {
    throw new UsageError(
      `${connector.label} needs your own OAuth client: Skeinwise ships none. docs/connectors.md says how to make one in a few minutes. Then: skeinwise connect ${service} --client-id <its ID>`,
    );
  }
  let port: number | undefined;
  if (v.port !== undefined) {
    port = Number(v.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new UsageError(`--port takes a port from 1024 to 65535, not "${v.port}".`);
  }

  say(consentText(connector, ctx.home));
  const previous = findConnection(ctx.home, service);
  if (previous) say(`\n${connector.label} is connected to ${previous.account}; connecting again replaces its token.\n`);
  await confirm(ctx, `\nConnect ${connector.label}? [y/N] `);

  // Sign in, or take the pasted token.
  const client: Client = {};
  if (clientId) client.id = clientId;
  const secret = await clientSecretFor(ctx, connector, d);
  if (secret) client.secret = secret;
  let token: Token;
  if (connector.signIn.kind === 'oauth') {
    const signed = await signIn({
      provider: connector.signIn.provider,
      client,
      scopes: connector.scopes.map((s) => s.scope),
      fetch: d.fetch,
      now: d.now,
      openUrl: (ctx.io as ConnectorIo).openUrl ?? openInBrowser,
      say: (line) => say(`${line}\n`),
      ...(port !== undefined ? { port } : connector.signIn.provider.port ? { port: connector.signIn.provider.port } : {}),
    });
    if (signed.granted) {
      const wanted = connector.scopes.map((s) => s.scope);
      const extra = signed.granted.filter((s) => !wanted.includes(s) && !/^(openid|email|profile)$|userinfo/.test(s));
      if (extra.length) ctx.io.err(`Note: ${connector.label} also granted ${extra.join(', ')}, which Skeinwise never uses.\n`);
      if (!wanted.every((s) => signed.granted!.includes(s))) {
        throw new UsageError(`${connector.label} didn't grant ${wanted.join(', ')}, so there is nothing to read. Nothing was connected.`);
      }
    }
    token = signed.token;
  } else {
    say(`${connector.signIn.how}\n`);
    token = await pastedToken(ctx, connector);
  }

  // Which account this is, and (Slack) which channels. Nothing is saved until both are known.
  const api = apiFor(service, token, client, ctx.home, { ...d, keychain: noKeychainYet });
  let account: string;
  let cursor: unknown = null;
  try {
    account = await connector.identify(api);
    if (service === 'slack') {
      const channels = await resolveChannels(api, picks);
      picks = Object.keys(channels);
      cursor = { channels, users: {} };
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`${connector.label} signed in, but ${(error as Error).message.replace(/\.$/, '')}. Nothing was saved.`);
  }
  if (previous && previous.account === account && previous.cursor) cursor = mergeCursor(service, previous.cursor, cursor);

  const items = keychainItems(ctx.home, service);
  await d.keychain.set(items.token, JSON.stringify(api.currentToken));
  if (client.secret) await d.keychain.set(items.clientSecret, client.secret);
  const connection: Connection = {
    service,
    account,
    ...(clientId ? { clientId } : {}),
    ...(service === 'todoist' ? { port: port ?? 8735 } : {}),
    picks,
    since: previous && previous.account === account ? previous.since : since,
    cursor,
    connectedAt: now,
  };
  putConnection(ctx.home, service, connection);

  // Connecting again brings a left-out source back in: the person asked to read it.
  const source = ctx.store.sources().find((s) => s.kind === service && s.location === account);
  if (source?.status === 'out') {
    ctx.store.setSourceStatus(source.id, 'in');
    say(`Source ${source.id} (${source.label}) was left out; it is back in.\n`);
  }

  say(`\nConnected ${connector.label} as ${account}. Reading it now...\n`);
  const [report] = await pollConnectors(ctx.store, ctx.home, { ...d, force: true, only: service });
  if (v.json) ctx.json({ service, account, picks, pulled: report });
  else {
    ctx.io.out(`${report?.line ?? ''}\n`);
    ctx.io.out(`\nskeinwise live keeps it up to date (every ${POLL_MINUTES} minutes); skeinwise connections shows how it is going.\n`);
  }
  return 0;
};

/** A Keychain that refuses: the token is saved only once the account is known. */
const noKeychainYet: Keychain = {
  get: async () => null,
  set: async () => undefined,
  delete: async () => false,
};

/** Reconnecting to the same account keeps where the last pull stopped (Slack: for the channels still picked). */
function mergeCursor(service: ServiceName, old: unknown, fresh: unknown): unknown {
  if (service !== 'slack' || !fresh) return old;
  const o = old as { channels?: Record<string, unknown>; users?: Record<string, string>; self?: string };
  const f = fresh as { channels: Record<string, unknown> };
  const channels: Record<string, unknown> = {};
  for (const [id, c] of Object.entries(f.channels)) channels[id] = o.channels?.[id] ?? c;
  return { ...o, channels };
}

const connections: Command = async (ctx) => {
  const v = values(ctx);
  if (v.pull) {
    const d = deps(ctx);
    if (!supported(d.platform)) throw notSupported(d.platform);
    await pollConnectors(ctx.store, ctx.home, { ...d, force: true });
  }
  const list = loadConnections(ctx.home);
  const now = ctx.store.now();
  if (v.json) {
    ctx.json(
      list.map((c) => ({
        service: c.service,
        account: c.account,
        source: sourceFor(c).label,
        picks: c.picks,
        connectedAt: c.connectedAt,
        lastPollAt: c.lastPollAt ?? null,
        nextPollAt: c.nextPollAt ?? null,
        status: c.status ?? null,
        failure: c.failure ?? null,
      })),
    );
    return 0;
  }
  if (!list.length) {
    ctx.io.out(`Nothing is connected. Try: skeinwise connect gmail (or ${SERVICES.filter((s) => s !== 'gmail').join(', ')})\n`);
    return 0;
  }
  for (const c of list) {
    const label = CONNECTORS[c.service].label;
    const picks = c.picks.length && c.service === 'slack' ? ` · ${channelNames(c).join(', ')}` : c.picks.length && c.service === 'calendar' ? ` · ${c.picks.join(', ')}` : '';
    ctx.io.out(`${label.padEnd(16)} ${c.account}${picks} · connected ${day(c.connectedAt)}\n`);
    ctx.io.out(`  ${c.status ?? 'not pulled yet'}\n`);
    if (c.failure === 'signed-out') ctx.io.out(`  Pulls are stopped until you connect again.\n`);
    else if (c.nextPollAt) ctx.io.out(`  Next pull ${relative(now, c.nextPollAt)} (while skeinwise live runs)\n`);
  }
  const missing = SERVICES.filter((s) => !list.some((c) => c.service === s));
  if (missing.length) ctx.io.out(`Not connected: ${missing.join(', ')}\n`);
  return 0;
};

function channelNames(c: Connection): string[] {
  const channels = (c.cursor as { channels?: Record<string, { name?: string }> } | null)?.channels ?? {};
  return c.picks.map((id) => `#${channels[id]?.name ?? id}`);
}

const disconnect: Command = async (ctx) => {
  const service = serviceArg(ctx, 'Disconnect');
  const connector = CONNECTORS[service];
  const v = values(ctx);
  const connection = findConnection(ctx.home, service);
  if (!connection) throw new UsageError(`${connector.label} isn't connected. skeinwise connections shows what is.`);
  if (v.keep && v.drop) throw new UsageError('Say --keep or --drop, not both.');
  const source = ctx.store.sources().find((s) => s.kind === service && s.location === connection.account);

  // The choice comes first, so a missing answer stops before anything changes.
  let keep = v.keep ? true : v.drop ? false : undefined;
  if (keep === undefined) {
    if (!source?.entries) keep = true;
    else {
      const answer = ctx.io.ask ? await ctx.io.ask(`Keep the ${itemCount(source.entries)} read from ${source.label} in search? [Y/n] `) : null;
      if (answer === null) throw new UsageError('There is no terminal to ask on. Say what happens to the items it read: --keep or --drop');
      keep = !/^n(o)?$/i.test(answer.trim());
    }
  }

  const d = deps(ctx);
  const items = keychainItems(ctx.home, service);
  if (supported(d.platform)) {
    let revoked = false;
    try {
      const { token, client } = await credentials(ctx.home, connection, d);
      const api = apiFor(service, token, client, ctx.home, d);
      await connector.revoke({ api, token, client, fetch: d.fetch });
      revoked = true;
    } catch (error) {
      const why = error instanceof ConnectorError && error.kind === 'signed-out' ? 'the access had already ended' : (error as Error).message;
      ctx.io.err(`Couldn't revoke the access at ${connector.label} (${why}). ${revokeByHand(service)}\n`);
    }
    await d.keychain.delete(items.token);
    await d.keychain.delete(items.clientSecret);
    ctx.io.out(revoked ? `Revoked Skeinwise's access at ${connector.label} and deleted the token from the Keychain.\n` : `Deleted the token from the Keychain.\n`);
    // Google may end every grant a client holds when one of its tokens is revoked.
    const sharing = revoked ? sameGoogleClient(ctx.home, connection) : undefined;
    if (sharing) {
      const other = CONNECTORS[sharing.service].label;
      ctx.io.err(`Note: ${other} uses the same Google client, and Google may have ended its access too. If skeinwise connections shows it signed out, run: skeinwise connect ${sharing.service}\n`);
    }
  }
  putConnection(ctx.home, service, null);

  if (source && source.entries) {
    if (keep) ctx.io.out(`Kept the ${itemCount(source.entries)} from ${source.label} (source ${source.id}).\n`);
    else {
      ctx.store.setSourceStatus(source.id, 'out');
      ctx.io.out(
        `Left the ${itemCount(source.entries)} from ${source.label} out of search and the map (source ${source.id}; skeinwise include ${source.id} brings them back). They are still in record.db: the record can't delete a source yet.\n`,
      );
    }
  }
  ctx.io.out(`${connector.label} is disconnected.\n`);
  return 0;
};

/** The other Google connection (Gmail or Calendar) signed in with the same client, if any. */
function sameGoogleClient(home: string, connection: Connection): Connection | undefined {
  const google = (s: ServiceName) => s === 'gmail' || s === 'calendar';
  if (!google(connection.service) || !connection.clientId) return undefined;
  return loadConnections(home).find((c) => c.service !== connection.service && google(c.service) && c.clientId === connection.clientId);
}

function itemCount(n: number): string {
  return n === 1 ? '1 item' : `${n} items`;
}

function revokeByHand(service: ServiceName): string {
  if (service === 'gmail' || service === 'calendar') return 'You can remove it yourself at https://myaccount.google.com/permissions.';
  if (service === 'todoist') return "You can remove it yourself in Todoist's Settings, under Integrations.";
  return "You can remove it yourself by uninstalling your app in Slack's app settings.";
}

export const CONNECTOR_COMMANDS: Record<string, Command> = { connect, connections, disconnect };
