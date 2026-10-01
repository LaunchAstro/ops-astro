// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-1 staging reset refuses production, its record (REVB1SL01S34D, the whole
// family): before anything is emptied the run's record must be a real file in
// a real folder, and hold the `started` line written to it. A link (to a file
// or to /dev/null or a device), a pipe or a linked folder is refused by setting
// name, and the database keeps what it held.

import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  canaryHolds,
  run,
  scratch,
  serverUrl,
  settings,
  stagingResetHooks,
} from './s0-1-staging-reset.fixture.ts';

stagingResetHooks();

const plant: Record<string, (records: string, record: string) => void> = {
  'a link to a real file': (records, record) => {
    writeFileSync(join(records, 'elsewhere.jsonl'), '');
    symlinkSync(join(records, 'elsewhere.jsonl'), record);
  },
  'a pipe': (_records, record) => execFileSync('mkfifo', [record]),
  'a link to a device': (_records, record) => symlinkSync('/dev/zero', record),
  'a linked folder': (records) => {
    const real = join(scratch, `real-${Date.now()}`);
    mkdirSync(real);
    symlinkSync(real, `${records}-linked`);
  },
};

it.skipIf(serverUrl === undefined)(
  'S0-1 staging reset refuses production: a record that is not a real file in a real folder',
  async () => {
    for (const [kind, make] of Object.entries(plant)) {
      const env = settings();
      const records = env['OPS_ASTRO_DEPLOYMENTS'] ?? '';
      mkdirSync(records, { recursive: true });
      make(records, join(records, 'deployments.jsonl'));
      if (kind === 'a linked folder') env['OPS_ASTRO_DEPLOYMENTS'] = `${records}-linked`;
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time, each checked
      const result = await run(env);
      expect(result.status, kind).toBe(1);
      expect(result.out, kind).toContain('OPS_ASTRO_DEPLOYMENTS');
      // oxlint-disable-next-line no-await-in-loop -- the database checked after each
      expect(await canaryHolds(), kind).toBe(true);
    }
  },
  180_000,
);
