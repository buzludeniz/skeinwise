// The file extensions read as notes, in one place. The importers, live capture, the note-folder count on the first
// screen and the matching of [[links]] to file names all use this list, so a new note format reaches every one of
// them or none. No imports: the organiser and the server use it too.

/** The extensions read as notes: Markdown, plain text and Word documents. */
export const NOTE_FILE_EXT: ReadonlySet<string> = new Set(['.md', '.markdown', '.txt', '.docx']);

/** The note extension a file name ends with, in any case, or null. */
function noteExtOf(name: string): string | null {
  const lower = name.toLowerCase();
  for (const ext of NOTE_FILE_EXT) if (lower.endsWith(ext)) return ext;
  return null;
}

/** Whether a file name is a note's, by its extension, in any case. */
export function isNoteFile(name: string): boolean {
  return noteExtOf(name) !== null;
}

/** A file name without its note extension (`Garden plan.docx` → `Garden plan`); any other name as it is. */
export function withoutNoteExt(name: string): string {
  const ext = noteExtOf(name);
  return ext ? name.slice(0, name.length - ext.length) : name;
}
