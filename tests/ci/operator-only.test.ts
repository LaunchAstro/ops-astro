// SPDX-License-Identifier: AGPL-3.0-only
// S0-1e: the operator gate and the deployment record (ticket S0-1, line A4).
//
// The person-only commands, staging preparation (`scripts/ops/operator.mjs
// prepare`), the promotion step (`scripts/ops/promote.mjs`) and the restore
// drill (`scripts/ops/restore-drill.mjs --drill`, `S0-3 operator only`), run
// through one check: a person's own sign-in, in the business named, holding
// `operations:manage` on the whole business. An agent credential, a call under
// a delegation, a person without the key, another business's operator and a
// client-scoped grant are each refused before the command acts: the service
// manager is never asked, the production link does not move and no deployment
// record is written. The commands run as the owner runs them, over a real
// database and a PATH whose docker and launchctl log every call.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
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
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
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

const OPERATOR = new URL('../../scripts/ops/operator.mjs', import.meta.url).pathname;
const PROMOTE = new URL('../../scripts/ops/promote.mjs', import.meta.url).pathname;
const DRILL = new URL('../../scripts/ops/restore-drill.mjs', import.meta.url).pathname;
const definition = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
) as { 'x-ops-astro': { artefact: string } };

const ISSUER = 'http://127.0.0.1:54391';
const STAGED = '0123456789ab';
const LINE = 'Tried the task page and the approval queue on staging; both behave.';
const CANARY = 'canary-7c2f41-operator-secret';

const serverUrl = databaseUrlFromEnvironment();
const scratch = mkdtempSync(join(tmpdir(), 's0-1e-'));
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

/** A PATH whose docker and launchctl append every call to `calls` and answer as the live manager. */
const manager = (apiRunning: boolean): { path: string; calls: string } => {
  const bin = mkdtempSync(join(scratch, 'bin-'));
  const calls = join(bin, 'calls.log');
  const inspect = JSON.stringify([
    { Name: '/prod-api', State: { Running: apiRunning }, HostConfig: {} },
  ]);
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh\necho "docker $*" >> '${calls}'\nif [ "$1" = ps ]; then echo api-id; exit 0; fi\nif [ "$1" = inspect ]; then printf '%s\\n' '${inspect}'; exit 0; fi\nif [ "$1" = start ]; then exit 0; fi\nif [ "$1" = compose ]; then exit 0; fi\nexit 2\n`,
  );
  writeFileSync(
    join(bin, 'launchctl'),
    `#!/bin/sh\necho "launchctl $*" >> '${calls}'\nprintf 'PID\\tStatus\\tLabel\\n-\\t0\\torg.example.prod-auth\\n'\n`,
  );
  for (const command of ['docker', 'launchctl']) chmodSync(join(bin, command), 0o755);
  return { path: `${bin}:${process.env['PATH'] ?? ''}`, calls };
};

const store = (): string => {
  const root = mkdtempSync(join(scratch, 'store-'));
  const build = join(root, definition['x-ops-astro'].artefact.replace('{version}', STAGED));
  mkdirSync(build);
  writeFileSync(join(build, 'build.json'), JSON.stringify({ build: STAGED }));
  return root;
};

interface Run {
  readonly status: number | null;
  readonly out: string;
}
const spawn = (command: string, args: readonly string[], env: Record<string, string>): Run => {
  const result = spawnSync(process.execPath, [command, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};

/** Where one command's attempt can leave a mark: the link, the record folder, the manager's log. */
interface Marks {
  readonly current: string;
  readonly records: string;
  readonly calls: string;
}
const marks = (fake: { calls: string }): Marks => {
  const current = join(mkdtempSync(join(scratch, 'prod-')), 'current');
  symlinkSync(join(scratch, 'previous-build'), current);
  const records = mkdtempSync(join(scratch, 'records-'));
  return { current, records, calls: fake.calls };
};

type Command = (env: Record<string, string>, at: Marks) => Run;
/** A private key file holding only the canary: a drill that read it could only leak it. */
const drillKey = (): string => {
  const file = join(mkdtempSync(join(scratch, 'key-')), 'restore.key');
  writeFileSync(file, `${CANARY}\n`);
  return file;
};
const COMMANDS: Record<string, Command> = {
  'staging preparation': (env) => spawn(OPERATOR, ['prepare'], env),
  // S0-3 operator only: the drill's store, key and scope are all set, so a
  // drill that skipped the gate would reach for them; a refused one never does.
  'the restore drill': (env) =>
    spawn(DRILL, ['--drill'], {
      RESTORE_STORE_URL: `postgres://drill:${CANARY}@127.0.0.1:1/never`,
      RESTORE_KEY_FILE: drillKey(),
      DRILL_BUSINESS_ID: randomUUID(),
      DRILL_CLIENT_ID: randomUUID(),
      DRILL_PERSON_ID: randomUUID(),
      ...env,
    }),
  'the promotion step': (env, at) =>
    spawn(
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
      ],
      env,
    ),
};

// ---- the gate's own refusals, before any database is asked ----------------

describe('S0-1 operator only, before any lookup', () => {
  for (const [name, command] of Object.entries(COMMANDS)) {
    it(`${name} with no sign-in is refused and asks nothing of the machine`, () => {
      const fake = manager(false);
      const at = marks(fake);
      const result = command(
        {
          PATH: fake.path,
          OPS_ASTRO_DEPLOYMENTS: at.records,
          DATABASE_URL: 'postgres://nobody@127.0.0.1:1/never',
          DATABASE_ADMIN_URL: `postgres://owner:${CANARY}@127.0.0.1:1/never`,
        },
        at,
      );
      expect(result.status, result.out).toBe(1);
      expect(result.out).toMatch(/operations:manage/u);
      expect(result.out).not.toMatch(/ECONNREFUSED|db-migrate/u);
      expect(result.out).not.toContain(CANARY);
      expect(existsSync(at.calls)).toBe(false);
      expect(readdirSync(at.records)).toEqual([]);
      expect(readlinkSync(at.current)).toBe(join(scratch, 'previous-build'));
    });
  }
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

// ---- the table, over a real database ---------------------------------------

describe.skipIf(serverUrl === undefined)('S0-1 operator only', () => {
  let db: FreshDatabase;
  let alphaBusiness = '';
  const subjects = {
    operator: `op-${randomUUID()}`,
    keyless: `kl-${randomUUID()}`,
    client: `cl-${randomUUID()}`,
    agent: `ag-${randomUUID()}`,
    betaOperator: `bo-${randomUUID()}`,
  };
  let operatorPerson = '';

  beforeAll(async () => {
    keySet = await serveTestKeySetApart();
    keySetUrl = keySet.url;
    db = await createFreshDatabase({ part: 's01e' });
    const alpha = await insertBusiness(db.app, 'alpha');
    alphaBusiness = alpha;
    const beta = await insertBusiness(db.app, 'beta');
    await db.app.withBusiness(alpha, async (tx) => {
      operatorPerson = await person(tx, 'Olive', subjects.operator, { scope: 'business' });
      await person(tx, 'Kit', subjects.keyless, { scope: 'business', action: 'read' });
      await person(tx, 'Cleo', subjects.client, { scope: 'party' });
      // An agent login, and a grant row planted on the agent's own actor: an
      // agent credential is refused even where a row names it.
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

  const adminUrl = (): string => {
    const url = new URL(serverUrl as string);
    url.pathname = `/${db.name}`;
    return url.toString();
  };
  const environment = (at: Marks, path: string, own: Record<string, string>) => ({
    PATH: path,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_DEPLOYMENTS: at.records,
    DATABASE_URL: db.appUrl,
    DATABASE_ADMIN_URL: adminUrl(),
    SUPABASE_KEY_SET_URL: keySetUrl,
    GOTRUE_URL: ISSUER,
    ...own,
  });

  const CALLERS: Record<string, () => Promise<Record<string, string>>> = {
    'an agent credential': async () => ({ OPS_ASTRO_TOKEN: await token(subjects.agent) }),
    'an agent credential, flagged as one': async () => ({
      OPS_ASTRO_TOKEN: await token(subjects.agent),
      OPS_ASTRO_AGENT: '1',
    }),
    "the operator's own sign-in under a delegation": async () => ({
      OPS_ASTRO_TOKEN: await token(subjects.operator),
      OPS_ASTRO_DELEGATION: CANARY,
    }),
    "the operator's own sign-in with a saved delegation": async () => ({
      OPS_ASTRO_TOKEN: await token(subjects.operator),
      OPS_ASTRO_DELEGATION_FILE: join(scratch, 'delegation'),
    }),
    'a person without the key (operations:read only)': async () => ({
      OPS_ASTRO_TOKEN: await token(subjects.keyless),
    }),
    'a person holding the key for one client only': async () => ({
      OPS_ASTRO_TOKEN: await token(subjects.client),
    }),
    "another business's operator": async () => ({
      OPS_ASTRO_TOKEN: await token(subjects.betaOperator),
    }),
    'a forged sign-in': async () => ({
      OPS_ASTRO_TOKEN: await token(subjects.operator, true),
    }),
  };

  for (const [commandName, command] of Object.entries(COMMANDS)) {
    for (const [callerName, caller] of Object.entries(CALLERS)) {
      it(`${commandName}, run by ${callerName}: refused before it acts, and writes nothing`, async () => {
        const fake = manager(false);
        const at = marks(fake);
        const own = await caller();
        const result = command(environment(at, fake.path, own), at);
        expect(result.status, result.out).toBe(1);
        expect(result.out).toMatch(/operations:manage/u);
        expect(result.out).not.toMatch(
          /db-migrate|promotion recorded|staging prepared|restore drill recorded|"outcome"/u,
        );
        for (const secret of [CANARY, own['OPS_ASTRO_TOKEN'] ?? CANARY]) {
          expect(result.out).not.toContain(secret);
        }
        expect(existsSync(at.calls), 'the service manager was asked').toBe(false);
        expect(readdirSync(at.records)).toEqual([]);
        expect(readlinkSync(at.current)).toBe(join(scratch, 'previous-build'));
      });
    }
  }

  for (const [commandName, command] of Object.entries(COMMANDS)) {
    it(`Sol proof, criterion 4: refused ${commandName} writes no authentication row`, async () => {
      const count = async (): Promise<number> =>
        await db.app.withBusiness(alphaBusiness, async (tx) => {
          const rows = await tx.query<{ n: number }>(
            'select count(*)::int as n from authentication_attempts where business_id = $1',
            [tx.businessId],
          );
          return rows[0]!.n;
        });
      const before = await count();
      const fake = manager(false);
      const at = marks(fake);
      const result = command(
        environment(at, fake.path, { OPS_ASTRO_TOKEN: await token(subjects.keyless) }),
        at,
      );
      expect(result.status, result.out).toBe(1);
      expect(await count()).toBe(before);
    });
  }

  for (const [commandName, command] of Object.entries(COMMANDS)) {
    it(`Sol proof, criterion 4: refused ${commandName} without a record folder writes no authentication row`, async () => {
      const count = async (): Promise<number> =>
        await db.app.withBusiness(alphaBusiness, async (tx) => {
          const rows = await tx.query<{ n: number }>(
            'select count(*)::int as n from authentication_attempts where business_id = $1',
            [tx.businessId],
          );
          return rows[0]!.n;
        });
      const before = await count();
      const fake = manager(false);
      const at = marks(fake);
      const env = environment(at, fake.path, { OPS_ASTRO_TOKEN: await token(subjects.operator) });
      delete (env as Partial<typeof env>).OPS_ASTRO_DEPLOYMENTS;
      const result = command(env, at);
      expect(result.status, result.out).toBe(1);
      expect(result.out).toMatch(/OPS_ASTRO_DEPLOYMENTS/u);
      expect(await count()).toBe(before);
    });
  }

  it('the operator prepares staging: the one command runs, and one record names the operator', async () => {
    const fake = manager(false);
    const at = marks(fake);
    const signIn = await token(subjects.operator);
    const result = COMMANDS['staging preparation']!(
      environment(at, fake.path, { OPS_ASTRO_TOKEN: signIn }),
      at,
    );
    expect(result.status, result.out).toBe(0);
    expect(readFileSync(at.calls, 'utf8')).toMatch(/^docker compose .*compose\.json.* create/mu);
    const records = readFileSync(join(at.records, 'deployments.jsonl'), 'utf8').trim().split('\n');
    expect(records).toHaveLength(1);
    const record = JSON.parse(records[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      action: 'staging prepared',
      business: 'alpha',
      operator: operatorPerson,
    });
    expect(Date.parse(record['at'] as string)).not.toBeNaN();
    expect(records[0]).not.toContain(signIn);
    expect(result.out).not.toContain(signIn);
  });

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

  it('Sol proof, criterion 4: running API promotion refusal writes no authentication row', async () => {
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

  it('Sol proof, criterion 14: a saved stopped report cannot bypass a live running API', async () => {
    // Carried from #109 (4ef3113) with the operator's sign-in added: the gate
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
});
