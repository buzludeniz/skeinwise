#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

/** package.json sits one level up from src/ and two from dist/src/. */
function readPackage(): { version: string } {
  for (const rel of ['../package.json', '../../package.json']) {
    const url = new URL(rel, import.meta.url);
    if (existsSync(url)) return JSON.parse(readFileSync(url, 'utf8')) as { version: string };
  }
  throw new Error('package.json not found');
}

const pkg = readPackage();

const HELP = `skeinwise ${pkg.version}: a second brain that organises itself

Usage: skeinwise <command> [options]

Commands:
  help        Show this help
  version     Print the version
`;

export function main(argv: string[]): number {
  const [command = 'help'] = argv;
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${pkg.version}\n`);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
