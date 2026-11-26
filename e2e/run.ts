// Where the e2e run keeps its record: SKEINWISE_E2E_RUN when it is set, else e2e/.run.

import { join } from 'node:path';

export function runFolder(): string {
  return process.env.SKEINWISE_E2E_RUN || join(import.meta.dirname, '.run');
}
