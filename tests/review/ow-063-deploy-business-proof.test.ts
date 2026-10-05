// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requireOperatingOperator } from '../../scripts/ops/operator.ts';
import { markMadeUp } from '../../scripts/ops/made-up-only.ts';
import {
  serverUrl,
  token,
  subjects,
  environment,
  operatorOnlyHooks,
} from '../ci/operator-only.fixture.ts';
import { manager, marks, COMMANDS } from '../ci/operator-only-commands.fixture.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';

let db: FreshDatabase;
describe.skipIf(serverUrl === undefined)('OW-063 deployment isolation', () => {
  operatorOnlyHooks((state) => {
    db = state.db;
  });

  it('business to business, beta operations manager cannot deploy alpha installation', async () => {
    await markMadeUp(db.admin, []);
    const fake = manager(false);
    const at = marks(fake);
    const pinned = `sha256:${'e'.repeat(64)}`;
    writeFileSync(
      join(fake.path.split(':')[0]!, 'docker'),
      [
        '#!/bin/sh',
        `echo "docker $*" >> '${at.calls}'`,
        'case "$1 $2" in',
        `  "compose "*) touch '${at.calls}.up' ;;`,
        `  "image inspect") echo ${pinned} ;;`,
        '  "inspect --format") shift 3',
        `    [ -f '${at.calls}.up' ] && for c in "$@"; do echo "/$c ${pinned}"; done ;;`,
        `  "ps "*) echo ${'a'.repeat(64)} ;;`,
        `  "inspect "*) printf '%s\\n' '[{"Name":"/prod-api","State":{"Running":true,"StartedAt":"t1"},"HostConfig":{}}]' ;;`,
        '  *) exit 2 ;;',
        'esac',
        '',
      ].join('\n'),
    );
    const env = environment(at, fake.path, {
      OPS_ASTRO_TOKEN: await token(subjects.betaOperator),
      OPS_ASTRO_BUSINESS: 'beta',
    });
    // The real installation gate recognises that beta is not operating it.
    expect(await requireOperatingOperator(env)).toMatchObject({ ok: false });
    const result = COMMANDS['the staging deploy']!(env, at);
    const machineCalls = existsSync(at.calls) ? readFileSync(at.calls, 'utf8') : '';
    expect({ status: result.status, machineCalls }, result.out).toEqual({
      status: 1,
      machineCalls: '',
    });
  });
});
