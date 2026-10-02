// SPDX-License-Identifier: AGPL-3.0-only
//
// The promotion suite's artefact store (S0-1 promotion same artefact): builds
// named as the staging definition names them, each carrying its stamp and the
// digest of its bytes.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { stampOutput } from '../../scripts/ops/build-output.ts';

const definition = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
) as { 'x-ops-astro': { artefact: string } };
/** The artefact name S0-1a's definition names, for one version. */
export const named = (version: string): string =>
  definition['x-ops-astro'].artefact.replace('{version}', version);

export const STAGED = '0123456789ab';
export const NEWER = 'fedcba987654';
export const LINE = 'Tried the task page and the approval queue on staging; both behave.';

export const scratch: string = mkdtempSync(join(tmpdir(), 's0-1d-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let stores = 0;
/** An artefact store: one directory per build, each carrying its own stamp. */
export const store = (builds: Record<string, string | null>): string => {
  stores += 1;
  const root = join(scratch, `store${stores}`);
  for (const [name, stamp] of Object.entries(builds)) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'index.html'), `<meta name="ops-astro-build">`);
    if (stamp === null) continue;
    stampOutput(join(root, name), stamp);
  }
  return root;
};
export const STORE = (): string => store({ [named(STAGED)]: STAGED, [named(NEWER)]: NEWER });
