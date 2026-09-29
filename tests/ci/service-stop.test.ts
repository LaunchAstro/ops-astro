// SPDX-License-Identifier: AGPL-3.0-only
// S0-1g: the gated stop of production's API and auth server (ticket S0-1).
//
// The promotion refuses while the API or the auth server runs (owner line 63),
// so a person stops them first. That stop is `scripts/ops/stop-production.mjs`:
// the operator gate answers first, then the service manager is asked to stop
// exactly the two named services with a fixed argument list, then the stop is
// recorded. An agent credential, a call under a delegation, a person without
// the key, a person holding it for one client only and another business's
// operator are each refused before the service manager is asked, and a refusal
// writes nothing: no record and no sign-in row. The service manager here is a
// fake on a PATH that holds no real docker, so no live service is touched.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  serveTestKeySetApart,
  signBearer,
  signForged,
  type ServedKeySet,
} from '../support/sign-in.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertAgentActor,
  insertAgentMapping,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';

const STOP = new URL('../../scripts/ops/stop-production.mjs', import.meta.url).pathname;
const PROMOTE = new URL('../../scripts/ops/promote.mjs', import.meta.url).pathname;
const definition = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
) as { 'x-ops-astro': { artefact: string } };

/** The one call the stop may make: both named services, nothing else. */
const THE_STOP = 'docker stop ops-astro-api ops-astro-auth';

const ISSUER = 'http://127.0.0.1:54391';
const CANARY = 'canary-3e91d0-stop-secret';
const STAGED = '0123456789ab';

const serverUrl = databaseUrlFromEnvironment();
const scratch = mkdtempSync(join(tmpdir(), 's0-1g-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The test key set on loopback, in its own process: the gate runs under spawnSync. */
let keySet: ServedKeySet | undefined;
let keySetUrl = '';
afterAll(async () => await keySet?.close());

/** A sign-in's ES256 bearer, as the provider issues it; `forged` signs with a stranger's key. */
const token = async (subject: string, forged = false): Promise<string> =>
  await (forged ? signForged : signBearer)({
    sub: subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 600,
  });

interface Fake {
  readonly path: string;
  readonly calls: string;
  readonly records: string;
}

/**
 * A PATH whose docker and launchctl log every call. The rest of the PATH is
 * the system's own folders, which hold no docker, so a call that escapes the
 * fake fails instead of reaching a live service. `inspect` answers with the
 * production containers running, as they are before the stop.
 */
const fake = (stopExit = 0): Fake => {
  const bin = mkdtempSync(join(scratch, 'bin-'));
  const calls = join(bin, 'calls.log');
  const inspect = JSON.stringify(
    ['ops-astro-api', 'ops-astro-auth'].map((name) => ({
      Name: `/${name}`,
      State: { Running: true },
      HostConfig: {},
    })),
  );
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh\necho "docker $*" >> '${calls}'\nif [ "$1" = stop ]; then exit ${stopExit}; fi\nif [ "$1" = ps ]; then echo api-id; exit 0; fi\nif [ "$1" = inspect ]; then printf '%s\\n' '${inspect}'; exit 0; fi\nexit 2\n`,
  );
  writeFileSync(
    join(bin, 'launchctl'),
    `#!/bin/sh\necho "launchctl $*" >> '${calls}'\nprintf 'PID\\tStatus\\tLabel\\n'\n`,
  );
  for (const command of ['docker', 'launchctl']) chmodSync(join(bin, command), 0o755);
  return { path: `${bin}:/usr/bin:/bin`, calls, records: mkdtempSync(join(scratch, 'records-')) };
};

interface Run {
  readonly status: number | null;
  readonly out: string;
}
const spawn = (command: string, args: readonly string[], env: Record<string, string>): Run => {
  const result = spawnSync(process.execPath, [command, ...args], {
    encoding: 'utf8',
    env: { HOME: process.env['HOME'] ?? '', ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};

const untouched = (at: Fake): void => {
  expect(existsSync(at.calls), 'the service manager was asked').toBe(false);
  expect(readdirSync(at.records), 'a record was written').toEqual([]);
};

describe('S0-1 gated stop, before any lookup', () => {
  it('takes no argument: a caller cannot name a service, and nothing is asked', () => {
    for (const args of [['docker:prod-db'], ['--api', 'docker:prod-db'], ['ops-astro-api']]) {
      const at = fake();
      const result = spawn(STOP, args, { PATH: at.path, OPS_ASTRO_DEPLOYMENTS: at.records });
      expect(result.status, result.out).toBe(2);
      expect(result.out).toMatch(/takes no argument/u);
      untouched(at);
    }
  });

  it('with no sign-in is refused and asks nothing of the machine', () => {
    const at = fake();
    const result = spawn(STOP, [], {
      PATH: at.path,
      OPS_ASTRO_DEPLOYMENTS: at.records,
      DATABASE_URL: 'postgres://nobody@127.0.0.1:1/never',
      DATABASE_ADMIN_URL: `postgres://owner:${CANARY}@127.0.0.1:1/never`,
    });
    expect(result.status, result.out).toBe(1);
    expect(result.out).toMatch(/REFUSED.*operations:manage/su);
    expect(result.out).not.toContain(CANARY);
    untouched(at);
  });

  it('flagged as an agent is refused before any lookup and asks nothing', () => {
    const at = fake();
    const result = spawn(STOP, [], {
      PATH: at.path,
      OPS_ASTRO_DEPLOYMENTS: at.records,
      OPS_ASTRO_AGENT: '1',
      OPS_ASTRO_TOKEN: CANARY,
      OPS_ASTRO_BUSINESS: 'alpha',
    });
    expect(result.status, result.out).toBe(1);
    expect(result.out).toMatch(/OPS_ASTRO_AGENT is set/u);
    expect(result.out).not.toContain(CANARY);
    untouched(at);
  });
});

/** A person with a login and a membership; the grant, if any, is on `operations`. */
const person = async (
  tx: TenantQuery,
  name: string,
  subject: string,
  grant?: { scope: 'business' | 'party'; action?: 'manage' | 'read' },
): Promise<string> => {
  const id = await insertPerson(tx, name);
  const actor = await insertActor(tx, id);
  await insertMembership(tx, id);
  await insertMapping(tx, await insertLogin(tx, subject), id, actor);
  if (grant !== undefined) {
    const issued = await issueGrant(tx, [{ kind: 'actor', id: actor }], {
      subject: { kind: 'person', id },
      scope:
        grant.scope === 'business'
          ? { kind: 'business', id: null }
          : { kind: 'party', id: randomUUID() },
      collection: 'operations',
      action: grant.action ?? 'manage',
      parentGrantId: null,
      grantedByActorId: actor,
    });
    expect(issued.ok).toBe(true);
  }
  return id;
};

let db: FreshDatabase;

let alphaBusiness = '';

let operatorPerson = '';

let secondOperator = '';

const subjects = {
  operator: `op-${randomUUID()}`,
  second: `op2-${randomUUID()}`,
  keyless: `kl-${randomUUID()}`,
  client: `cl-${randomUUID()}`,
  agent: `ag-${randomUUID()}`,
  betaOperator: `bo-${randomUUID()}`,
};

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

// Each caller names the separation its refusal proves.
const CALLERS: Record<string, () => Promise<Record<string, string>>> = {
  'an agent credential (person to agent)': async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.agent),
  }),
  "the operator's own sign-in under a delegation (person to delegate)": async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.operator),
    OPS_ASTRO_DELEGATION: CANARY,
  }),
  "the operator's own sign-in with a saved delegation (person to delegate)": async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.operator),
    OPS_ASTRO_DELEGATION_FILE: join(scratch, 'delegation'),
  }),
  'a person without the key, operations:read only (person to person)': async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.keyless),
  }),
  'a person holding the key for one client only (client to client)': async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.client),
  }),
  "another business's operator (business to business)": async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.betaOperator),
  }),
  'a forged sign-in': async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.operator, true),
  }),
};

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
