// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const originalLog = console.log;
let fired = false;
console.log = (...args) => {
  if (!fired && typeof args[0] === 'string' && args[0].includes('"seedMs"')) {
    const { template } = JSON.parse(args[0]);
    const run = spawnSync(
      'docker',
      ['exec', process.env['FIXTURE_PG_CONTAINER'], 'createdb', '-U', 'postgres', template],
      { encoding: 'utf8' },
    );
    if (run.status !== 0) throw new Error(`race setup failed: ${run.stderr}`);
    writeFileSync(process.env['FIXTURE_RACE_MARKER'], template);
    fired = true;
  }
  originalLog(...args);
};
