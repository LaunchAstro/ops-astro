// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-1e and S0-6d: `S0-1 operator only`, continued: the promotion's saved
// report and arguments, Sol's criterion 14 proof, the operator's staging
// deploy and the operator's promotion. The fixtures are
// operator-only.fixture.ts; the refused callers are in operator-only.test.ts.

import { readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  serverUrl,
  token,
  subjects,
  environment,
  operatorOnlyHooks,
} from './operator-only.fixture.ts';
import {
  PROMOTE,
  definition,
  STAGED,
  LINE,
  manager,
  store,
  spawn,
  marks,
  COMMANDS,
} from './operator-only-commands.fixture.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';
import { markMadeUp } from '../../scripts/ops/made-up-only.ts';

let db: FreshDatabase;
let operatorPerson = '';

describe.skipIf(serverUrl === undefined)('S0-1 operator only', () => {
  operatorOnlyHooks((state) => ({ db, operatorPerson } = state));

  operatorOnlyCases6();
  operatorOnlyCases7();
});

/** A docker that answers the deploy's own calls: a build that prints `built`, Compose and inspects. */
function fakeDocker(path: string, calls: string, built: string): void {
  const pinned = `sha256:${'e'.repeat(64)}`;
  const bin = join(path.split(':')[0]!);
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      `echo "docker $*" >> '${calls}'`,
      'case "$1 $2" in',
      `  "build "*) echo ${built} ;;`,
      '  "compose "*) ;;',
      `  "image inspect") echo ${pinned} ;;`,
      '  "inspect --format")',
      '    shift 3',
      '    for c in "$@"; do',
      `      case "$c" in *-api|*-web) echo "/$c ${built}" ;; *) echo "/$c ${pinned}" ;; esac`,
      '    done ;;',
      '  "ps "*) echo api-id ;;',
      `  "inspect "*) printf '%s\\n' '[{"Name":"/prod-api","State":{"Running":true,"StartedAt":"t1"},"HostConfig":{}}]' ;;`,
      '  *) exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
  );
}

function operatorOnlyCases6() {
  it('the operator deploys a stored build to staging: one record names the version, the image and the operator', async () => {
    const fake = manager(false);
    const at = marks(fake);
    const built = `sha256:${'a'.repeat(64)}`;
    fakeDocker(fake.path, at.calls, built);
    // Staging's database, as its seed leaves it: marked made-up, so the preflight passes.
    await markMadeUp(db.admin, []);
    const signIn = await token(subjects.operator);
    const result = COMMANDS['the staging deploy']!(
      environment(at, fake.path, { OPS_ASTRO_TOKEN: signIn }),
      at,
    );
    expect(result.status, result.out).toBe(0);
    const calls = readFileSync(at.calls, 'utf8');
    expect(calls).toMatch(/^docker build .*Dockerfile/mu);
    expect(calls).toMatch(/^docker compose .*compose\.json.* up --detach --wait/mu);
    const records = readFileSync(join(at.records, 'deployments.jsonl'), 'utf8').trim().split('\n');
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]!)).toMatchObject({
      action: 'deploy recorded',
      version: STAGED,
      image: built,
      business: 'alpha',
      operator: operatorPerson,
    });
    expect(records[0]).not.toContain(signIn);
    expect(result.out).not.toContain(signIn);
  }, 60_000);
}

function operatorOnlyCases7() {
  it('the operator promotes a stopped app: migrated, pointed, started, and one record names the operator', async () => {
    const fake = manager(false);
    const at = marks(fake);
    // The migration runner refuses while anything else is connected, so the
    // test's own sessions end first; the gate closes its own before it migrates.
    await db.closeSessions();
    await db.admin.close();
    const signIn = await token(subjects.operator);
    const artefacts = store();
    const result = spawn(
      PROMOTE,
      [
        '--version',
        STAGED,
        '--artefacts',
        artefacts,
        '--line',
        LINE,
        '--api',
        'docker:prod-api',
        '--auth',
        'launchd:org.example.prod-auth',
        '--current',
        at.current,
      ],
      environment(at, fake.path, { OPS_ASTRO_TOKEN: signIn }),
    );
    expect(result.status, result.out).toBe(0);
    expect(readlinkSync(at.current)).toBe(
      join(artefacts, definition['x-ops-astro'].artefact.replace('{version}', STAGED)),
    );
    const records = readFileSync(join(at.records, 'deployments.jsonl'), 'utf8').trim().split('\n');
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]!)).toMatchObject({
      action: 'promotion recorded',
      version: STAGED,
      line: LINE,
      dryRun: false,
      business: 'alpha',
      operator: operatorPerson,
    });
    expect(records[0]).not.toContain(signIn);
  }, 60_000);
}
