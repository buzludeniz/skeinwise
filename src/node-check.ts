/**
 * The Node check that runs before anything else (src/bin.ts). Skeinwise needs node:sqlite and the rest of Node 24, and
 * on an older Node it would fail inside an import with a stack trace, or on the import of node:sqlite itself. This file
 * imports nothing, so it loads on any Node that runs ES modules.
 */
export const NODE_MAJOR = 24;

/** The message for a Node older than 24, or undefined when this one will do. */
export function oldNodeMessage(version: string): string | undefined {
  const major = Number.parseInt(version.replace(/^v/, ''), 10);
  if (major >= NODE_MAJOR) return undefined;
  return [
    `Skeinwise needs Node ${NODE_MAJOR} or newer, and this is Node ${version}.`,
    'Install the current LTS from https://nodejs.org/en/download (or with your version manager), then run the command again.',
    '',
  ].join('\n');
}
