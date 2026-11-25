// Picking files or a folder and bringing them in; the app menu, the Add panel and drops all come here.

import { loadRecord, message, toast } from './actions.ts';
import { growOnNextLoad } from './brain/useBrain.ts';
import { importSummary, uploadFiles } from './upload.ts';

export function pickFiles(folder = false): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (folder) input.webkitdirectory = true;
  else input.accept = '.zip,.md,.markdown,.txt,.json,.jsonl';
  input.addEventListener('change', () => void bringInFiles([...(input.files ?? [])]));
  input.click();
}

export async function bringInFiles(files: File[], owner = 'you'): Promise<void> {
  if (!files.length) return;
  toast(`Bringing in ${files.length === 1 ? files[0]!.name : `${files.length} files`}…`);
  try {
    const results = await uploadFiles(files, owner);
    growOnNextLoad();
    await loadRecord();
    toast(importSummary(results), { tone: 'ok' });
  } catch (error) {
    toast(message(error), { tone: 'error' });
  }
}

/** A file whose path inside a dropped folder is kept, the way a folder picker keeps it. */
function withPath(file: File, path: string): File {
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

function readEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    return new Promise((done) =>
      (entry as FileSystemFileEntry).file(
        (f) => {
          out.push(entry.fullPath.split('/').filter(Boolean).length > 1 ? withPath(f, entry.fullPath.replace(/^\/+/, '')) : f);
          done();
        },
        () => done(),
      ),
    );
  }
  if (!entry.isDirectory) return Promise.resolve();
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  return new Promise((done) => {
    const batch = () =>
      reader.readEntries(
        async (list) => {
          if (!list.length) return done();
          for (const e of list) await readEntry(e, out);
          batch();
        },
        () => done(),
      );
    batch();
  });
}

/** The files in a drop, folders included. */
export async function droppedFiles(data: DataTransfer): Promise<File[]> {
  const entries = [...data.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...data.files];
  const out: File[] = [];
  for (const e of entries) await readEntry(e, out);
  return out;
}
