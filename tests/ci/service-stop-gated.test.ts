// SPDX-License-Identifier: AGPL-3.0-only
// S0-1e: `S0-1 gated stop` on a real database: the operator's stop, and every
// other caller refused before the service manager is asked. The fixtures are
// service-stop.fixture.ts; the refusals before any lookup are in
// service-stop.test.ts.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveTestKeySetApart, type ServedKeySet } from '../support/sign-in.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import {
  insertAgentActor,
  insertAgentMapping,
  insertBusiness,
  insertLogin,
} from '../identity/fixture.ts';
import {
  STOP,
  PROMOTE,
  definition,
  THE_STOP,
  ISSUER,
  CANARY,
  STAGED,
  serverUrl,
  scratch,
  token,
  type Fake,
  fake,
  spawn,
  untouched,
  person,
  subjects,
  CALLERS,
} from './service-stop.fixture.ts';
import { outputDigest } from '../../scripts/ops/build-output.ts';

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The test key set on loopback, in its own process: the gate runs under spawnSync. */
let keySet: ServedKeySet | undefined;

let keySetUrl = '';

afterAll(async () => await keySet?.close());

let db: FreshDatabase;

let alphaBusiness = '';

let operatorPerson = '';

let secondOperator = '';

const adminUrl = (): string => {
  const url = new URL(serverUrl as string);
  url.pathname = `/${db.name}`;
  return url.toString();
};

const environment = (at: Fake, own: Record<string, string>): Record<string, string> => ({
  PATH: at.path,
  OPS_ASTRO_BUSINESS: 'alpha',
  OPS_ASTRO_DEPLOYMENTS: at.records,
  DATABASE_URL: db.appUrl,
  DATABASE_ADMIN_URL: adminUrl(),
  SUPABASE_KEY_SET_URL: keySetUrl,
  GOTRUE_URL: ISSUER,
  ...own,
});

const signIns = async (): Promise<number> =>
  await db.app.withBusiness(alphaBusiness, async (tx) => {
    const rows = await tx.query<{ n: number }>(
      'select count(*)::int as n from authentication_attempts where business_id = $1',
      [tx.businessId],
    );
    return rows[0]!.n;
  });

describe.skipIf(serverUrl === undefined)('S0-1 gated stop', () => {
  beforeAll(async () => {
    keySet = await serveTestKeySetApart();
    keySetUrl = keySet.url;
    db = await createFreshDatabase({ part: 's01g' });
    alphaBusiness = await insertBusiness(db.app, 'alpha');
    const beta = await insertBusiness(db.app, 'beta');
    await db.app.withBusiness(alphaBusiness, async (tx) => {
      operatorPerson = await person(tx, 'Olive', subjects.operator, { scope: 'business' });
      secondOperator = await person(tx, 'Omar', subjects.second, { scope: 'business' });
      await person(tx, 'Kit', subjects.keyless, { scope: 'business', action: 'read' });
      await person(tx, 'Cleo', subjects.client, { scope: 'party' });
      // An agent login with a grant row planted on its own actor: an agent
      // credential is refused even where a row names it.
      const agent = await insertAgentActor(tx);
      await insertAgentMapping(tx, await insertLogin(tx, subjects.agent), agent, agent);
      const planted = await issueGrant(tx, [{ kind: 'actor', id: agent }], {
        subject: { kind: 'actor', id: agent },
        scope: { kind: 'business', id: null },
        collection: 'operations',
        action: 'manage',
        parentGrantId: null,
        grantedByActorId: agent,
      });
      expect(planted.ok).toBe(true);
    });
    await db.app.withBusiness(beta, async (tx) => {
      await person(tx, 'Bea', subjects.betaOperator, { scope: 'business' });
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
    rmSync(scratch, { recursive: true, force: true });
  });

  gatedStopCases1();
  gatedStopCases2();
});

function gatedStopCases1() {
  for (const [callerName, caller] of Object.entries(CALLERS)) {
    it(`run by ${callerName}: refused, stops nothing and writes nothing`, async () => {
      const before = await signIns();
      const at = fake();
      const own = await caller();
      const result = spawn(STOP, [], environment(at, own));
      expect(result.status, result.out).toBe(1);
      expect(result.out).toMatch(/REFUSED.*operations:manage/su);
      expect(result.out).not.toMatch(/stopped/u);
      for (const secret of [CANARY, own['OPS_ASTRO_TOKEN'] ?? CANARY]) {
        expect(result.out).not.toContain(secret);
      }
      untouched(at);
      expect(await signIns(), 'a refused stop wrote a sign-in row').toBe(before);
    });
  }

  it('the operator stops exactly the two named services, and one record names the operator', async () => {
    const at = fake();
    const signIn = await token(subjects.operator);
    const result = spawn(STOP, [], environment(at, { OPS_ASTRO_TOKEN: signIn }));
    expect(result.status, result.out).toBe(0);
    expect(readFileSync(at.calls, 'utf8')).toBe(`${THE_STOP}\n`);
    const records = readFileSync(join(at.records, 'deployments.jsonl'), 'utf8').trim().split('\n');
    expect(records).toHaveLength(1);
    const record = JSON.parse(records[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      action: 'production stopped',
      services: ['docker:ops-astro-api', 'docker:ops-astro-auth'],
      business: 'alpha',
      operator: operatorPerson,
    });
    // Person to person: the record names the person who signed in, never
    // another holder of the same key in the same business.
    expect(records[0]).not.toContain(secondOperator);
    expect(Date.parse(record['at'] as string)).not.toBeNaN();
    expect(records[0]).not.toContain(signIn);
    expect(result.out).not.toContain(signIn);
  });
}

function gatedStopCases2() {
  it('a stop the service manager does not complete says so and writes no record', async () => {
    const at = fake(1);
    const result = spawn(
      STOP,
      [],
      environment(at, { OPS_ASTRO_TOKEN: await token(subjects.operator) }),
    );
    expect(result.status, result.out).toBe(1);
    expect(result.out).toMatch(/FAILED/u);
    expect(readFileSync(at.calls, 'utf8')).toBe(`${THE_STOP}\n`);
    expect(readdirSync(at.records)).toEqual([]);
  });

  it('owner line 63 holds: while the named services run, the promotion still refuses', async () => {
    const at = fake();
    const artefacts = mkdtempSync(join(scratch, 'store-'));
    const build = join(artefacts, definition['x-ops-astro'].artefact.replace('{version}', STAGED));
    mkdirSync(build);
    writeFileSync(join(build, 'build.json'), JSON.stringify({ build: STAGED }));
    writeFileSync(
      join(build, 'build.json'),
      JSON.stringify({ build: STAGED, digest: outputDigest(build) }),
    );
    const current = join(scratch, 'current');
    const result = spawn(
      PROMOTE,
      [
        '--version',
        STAGED,
        '--artefacts',
        artefacts,
        '--line',
        'Tried it on staging.',
        '--api',
        'docker:ops-astro-api',
        '--auth',
        'docker:ops-astro-auth',
        '--current',
        current,
      ],
      environment(at, { OPS_ASTRO_TOKEN: await token(subjects.operator) }),
    );
    expect(result.status, result.out).toBe(1);
    expect(result.out).toMatch(/docker:ops-astro-api is running/u);
    expect(readFileSync(at.calls, 'utf8')).not.toMatch(/stop|start/u);
    expect(existsSync(current)).toBe(false);
    expect(readdirSync(at.records)).toEqual([]);
  });
}
