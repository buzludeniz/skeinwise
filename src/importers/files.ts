// One way in for every file an import reads from disk: exports (.json, .jsonl), notes (.md, .markdown, .txt) and Word
// documents (.docx). Each goes through the safe reader (src/fsafe.ts) and comes back as text, decoded the way its bytes
// say (src/importers/text.ts). A .docx comes back as a Markdown note whose front matter carries its title and date.

import { extname } from 'node:path';
import type { SafeOptions } from '../fsafe.ts';
import { docxNoteText, readDocx } from './docx.ts';
import { readTextFile } from './text.ts';

/** The extensions an import reads from a folder or a named file. Everything else is passed over. */
export const IMPORT_EXT: ReadonlySet<string> = new Set(['.json', '.jsonl', '.md', '.markdown', '.txt', '.docx']);

/** The extensions read as notes. */
export const NOTE_FILE_EXT: ReadonlySet<string> = new Set(['.md', '.markdown', '.txt', '.docx']);

export interface ImportText {
  path: string;
  text: string;
  sha256: string;
  mtime: Date;
}

/**
 * Reads one file for an import. Throws UnsafeFileError (naming the file and why) for a link, a non-file, a file over
 * its limit, binary data under a text name, or a .docx that is damaged or a bomb; an errno error when it can't be read.
 */
export function readImportFile(path: string, options: SafeOptions = {}): ImportText {
  if (extname(path).toLowerCase() === '.docx') {
    const doc = readDocx(path, options);
    return { path: doc.path, text: docxNoteText(doc), sha256: doc.sha256, mtime: doc.mtime };
  }
  const file = readTextFile(path, options);
  return { path: file.path, text: file.text, sha256: file.sha256, mtime: file.mtime };
}
