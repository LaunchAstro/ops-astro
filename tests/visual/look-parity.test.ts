// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { LOOK_SCREENS } from './look/index.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

// The look probes of every screen (tests/visual/look/*.ts), held to the values
// pinned from the mockup. look.ts serves the app from source, draws it from the
// made-up reads and prints one line per probe, width and theme; a red line
// names the property and both values. One run per screen, so each fits its own
// time limit beside the rest of the suite and a slow screen names itself.
// A screen that holds a ticket's visual match carries that ticket's test name.
const NAMED: Readonly<Record<string, string>> = {
  frame: "; C4 visual match: the freshness marker held to the mockup's #fresh marker",
};
it.each(LOOK_SCREENS.map((screen) => [screen.id, NAMED[screen.id] ?? '']))(
  'the %s screen matches the pinned mockup on its look probes%s',
  (id) => {
    const out = mkdtempSync(join(tmpdir(), `look-${id}-`));
    try {
      const run = spawnSync(
        process.execPath,
        ['tests/visual/look.ts', '--screen', id, '--out', out],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 300_000,
        },
      );
      const red = run.stdout.split('\n').filter((line) => line.startsWith('red '));
      expect(red, run.stderr).toEqual([]);
      expect(run.status, run.stdout.slice(-2000) + run.stderr).toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  },
  330_000,
);
