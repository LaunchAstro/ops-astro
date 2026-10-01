// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-1e: `S0-1 operator only`, continued: the operator prepares staging, a
// record folder that is not named, the promotion past the gate refusing a
// running API, and a completed act's record. The fixtures are
// operator-only.fixture.ts; the refused callers are in operator-only.test.ts.

import { existsSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
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
  STAGED,
  LINE,
  scratch,
  manager,
  store,
  spawn,
  marks,
  COMMANDS,
} from './operator-only-commands.fixture.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';

let db: FreshDatabase;
let alphaBusiness = '';

describe.skipIf(serverUrl === undefined)('S0-1 operator only', () => {
  operatorOnlyHooks((state) => ({ db, alphaBusiness } = state));

  operatorOnlyCases3();
  operatorOnlyCases4();
  operatorOnlyCases5();
});

function operatorOnlyCases3() {
  it('a record folder that is not named refuses the operator before the command acts', async () => {
    const fake = manager(false);
    const at = marks(fake);
    const env = environment(at, fake.path, { OPS_ASTRO_TOKEN: await token(subjects.operator) });
    delete (env as Partial<typeof env>).OPS_ASTRO_DEPLOYMENTS;
    const result = COMMANDS['staging preparation']!(env, at);
    expect(result.status, result.out).toBe(1);
    expect(result.out).toMatch(/OPS_ASTRO_DEPLOYMENTS/u);
    expect(existsSync(at.calls)).toBe(false);
  });

  it('past the gate, the promotion still refuses a running API and writes no record', async () => {
    const fake = manager(true);
    const at = marks(fake);
    const result = COMMANDS['the promotion step']!(
      environment(at, fake.path, { OPS_ASTRO_TOKEN: await token(subjects.operator) }),
      at,
    );
    expect(result.status, result.out).toBe(1);
    expect(result.out).toMatch(/docker:prod-api is running/u);
    expect(readdirSync(at.records)).toEqual([]);
    expect(readlinkSync(at.current)).toBe(join(scratch, 'previous-build'));
  });

  it('running API promotion refusal writes no authentication row', async () => {
    const count = async (): Promise<number> =>
      await db.app.withBusiness(alphaBusiness, async (tx) => {
        const rows = await tx.query<{ n: number }>(
          'select count(*)::int as n from authentication_attempts where business_id = $1',
          [tx.businessId],
        );
        return rows[0]!.n;
      });
    const before = await count();
    const fake = manager(true);
    const at = marks(fake);
    const result = COMMANDS['the promotion step']!(
      environment(at, fake.path, { OPS_ASTRO_TOKEN: await token(subjects.operator) }),
      at,
    );
    expect(result.status, result.out).toBe(1);
    expect(result.out).toMatch(/docker:prod-api is running/u);
    expect(await count()).toBe(before);
  });
}

function operatorOnlyCases4() {
  it("a completed act records the operator's sign-in once, after the act", async () => {
    const count = async (): Promise<number> =>
      await db.app.withBusiness(alphaBusiness, async (tx) => {
        const rows = await tx.query<{ n: number }>(
          "select count(*)::int as n from authentication_attempts where business_id = $1 and outcome = 'resolved'",
          [tx.businessId],
        );
        return rows[0]!.n;
      });
    const before = await count();
    const fake = manager(false);
    const at = marks(fake);
    const result = COMMANDS['staging preparation']!(
      environment(at, fake.path, { OPS_ASTRO_TOKEN: await token(subjects.operator) }),
      at,
    );
    expect(result.status, result.out).toBe(0);
    expect(
      readFileSync(join(at.records, 'deployments.jsonl'), 'utf8').trim().split('\n'),
    ).toHaveLength(1);
    expect(await count()).toBe(before + 1);
  });

  it('past the gate, the promotion takes no saved report and no argument it does not know', async () => {
    const fake = manager(false);
    const at = marks(fake);
    const env = environment(at, fake.path, { OPS_ASTRO_TOKEN: await token(subjects.operator) });
    const base = ['--version', STAGED, '--artefacts', store(), '--line', LINE];
    for (const saved of ['--docker-inspect', '--launchctl']) {
      const result = spawn(PROMOTE, [...base, saved, join(scratch, 'saved.json')], env);
      expect(result.status, result.out).toBe(1);
      expect(result.out).toMatch(/never a saved report/u);
    }
    const typo = spawn(PROMOTE, [...base, '--dryrun'], env);
    expect(typo.status, typo.out).toBe(2);
    expect(typo.out).toMatch(/--dryrun is not an argument/u);
    expect(readdirSync(at.records)).toEqual([]);
  });
}

function operatorOnlyCases5() {
  it('a saved stopped report cannot bypass a live running API', async () => {
    // Carried from #109 (9d5916c) with the operator's sign-in added: the gate
    // now answers first, so the proof runs past it to the bypass it tests.
    const fake = manager(true);
    const at = marks(fake);
    const docker = join(scratch, 'sol-false-stopped-docker.json');
    writeFileSync(
      docker,
      JSON.stringify([{ Name: '/prod-api', State: { Running: false }, HostConfig: {} }]),
    );
    const launchd = join(scratch, 'sol-false-stopped-launchctl.txt');
    writeFileSync(launchd, 'PID\tStatus\tLabel\n-\t0\torg.example.prod-auth\n');
    const result = spawn(
      PROMOTE,
      [
        '--version',
        STAGED,
        '--artefacts',
        store(),
        '--line',
        LINE,
        '--api',
        'docker:prod-api',
        '--auth',
        'launchd:org.example.prod-auth',
        '--current',
        at.current,
        '--docker-inspect',
        docker,
        '--launchctl',
        launchd,
      ],
      environment(at, fake.path, { OPS_ASTRO_TOKEN: await token(subjects.operator) }),
    );
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/running|fixture|saved report/iu);
    expect(result.out).not.toMatch(/db-migrate|ECONNREFUSED/iu);
    expect(readlinkSync(at.current)).toBe(join(scratch, 'previous-build'));
  });
}
