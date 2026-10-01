// SPDX-License-Identifier: AGPL-3.0-only
// A staging backup must refuse an unlisted source before starting pg_dump.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const bin = mkdtempSync(join(tmpdir(), 'staging-backup-egress-'));
writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 99\n');
chmodSync(join(bin, 'docker'), 0o755);
afterAll(() => rmSync(bin, { recursive: true, force: true }));

it('staging backup refuses a source when its egress pooler settings are missing', () => {
  const run = spawnSync(process.execPath, ['scripts/ops/backup.mjs', 'run'], {
    encoding: 'utf8',
    env: {
      PATH: bin,
      OPS_ENVIRONMENT: 'staging',
      BACKUP_SOURCE_URL: 'postgres://backup:example@127.0.0.1:1/none',
      BACKUP_STORE_URL: 'postgres://store:example@127.0.0.1:1/none',
      BACKUP_PUBLIC_KEY_FILE: resolve('package.json'),
    },
  });

  expect(run.status).toBe(1);
  expect(JSON.parse(run.stdout)).toMatchObject({
    event: 'backup run',
    outcome: 'failed',
    stage: 'config',
  });
});
