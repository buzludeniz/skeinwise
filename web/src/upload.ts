// Sends picked or dropped files to the server, which saves them under the record's imports folder and brings them in.
// Each zip and each top-level folder becomes its own import; loose Markdown files go in a folder of their own.

import { api } from './api.ts';
import { plural } from './format.ts';
import type { ImportResult } from './types.ts';

/** The folder that loose files (not zips, not inside a picked folder) are put in, so they import as one notes source. */
export const LOOSE_FOLDER = 'Added notes';

/** Where a picked file goes inside the upload batch. */
export function uploadPath(name: string, relative: string): string {
  const rel = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.includes('/')) return rel;
  if (name.toLowerCase().endsWith('.zip')) return name;
  return `${LOOSE_FOLDER}/${name}`;
}

/** A batch id the server accepts: 8 to 40 lowercase letters and digits. */
export function batchId(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 16; i++) out += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(random() * 36)];
  return out;
}

/** Which of the files can be brought in: zips, Markdown and text notes, and JSON exports. */
export function usable(name: string): boolean {
  return /\.(zip|md|markdown|txt|json|jsonl)$/i.test(name) && !name.split('/').some((part) => part.startsWith('.'));
}

export async function uploadFiles(
  files: readonly File[],
  owner = 'you',
  onProgress: (done: number, total: number) => void = () => {},
): Promise<ImportResult[]> {
  const batch = batchId();
  const picked = files.filter((f) => usable(f.webkitRelativePath || f.name));
  if (!picked.length) throw new Error('None of those files can be brought in. Pick a zip export, Markdown notes or a folder of them.');
  let done = 0;
  for (const file of picked) {
    const path = uploadPath(file.name, file.webkitRelativePath || '');
    await api.upload(`upload?batch=${batch}&path=${encodeURIComponent(path)}`, file);
    onProgress(++done, picked.length);
  }
  return api.post<ImportResult[]>('upload/finish', { batch, owner });
}

/** A source the server held back: its changes wait for a yes, so its zero counts don't mean "nothing new". */
const heldBack = (r: ImportResult) => !!r.proposed;

/** Whether any source was held back, so the toast doesn't read as a plain success. */
export const anyHeldBack = (results: readonly ImportResult[]) => results.some(heldBack);

/** What a held-back source says, as the CLI's import line does: where its changes wait, or that they waited before. */
function heldLine(r: ImportResult): string {
  const n = r.proposed ?? 0;
  if (r.pendingId) return `${r.source}: ${plural(n, 'change')} from another account ${n === 1 ? 'waits' : 'wait'} for your yes as #${r.pendingId}: skeinwise live pending.`;
  return `${r.source}: nothing brought in; this export from another account was proposed before.`;
}

/** "Added 120 entries from ChatGPT" or the like, for a toast, then a line for each source held back. */
export function importSummary(results: readonly ImportResult[]): string {
  if (!results.length) return 'Nothing in those files could be read.';
  const came = results.filter((r) => !heldBack(r));
  const lines = results.filter(heldBack).map(heldLine);
  if (came.length) lines.unshift(cameLine(came));
  return lines.join(' ');
}

function cameLine(results: readonly ImportResult[]): string {
  const added = results.reduce((n, r) => n + r.added, 0);
  const versioned = results.reduce((n, r) => n + r.versioned, 0);
  const names = [...new Set(results.map((r) => r.source))];
  const from = names.length === 1 ? names[0] : `${names.length} sources`;
  if (!added && !versioned) return `Already in the record: nothing new from ${from}.`;
  const parts = [`${added} new ${added === 1 ? 'entry' : 'entries'}`];
  if (versioned) parts.push(`${versioned} updated`);
  return `Brought in ${parts.join(' and ')} from ${from}.`;
}
