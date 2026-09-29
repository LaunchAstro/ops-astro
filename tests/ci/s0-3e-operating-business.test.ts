// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3e: the export, the drill and the record are the installation's appointed
// operator's acts only (REV158K criterion 4; ORCH-DECISION 19:31:54Z). A drill
// needs the whole database, so the archive stays whole and sealed, and the
// gate admits only `operations:manage` over the whole of the operating
// business the installation names. Each case runs the real gate
// (operator.ts) against the real database operator-only.fixture.ts makes.
//
// Sol's criterion 4 export proofs (REV158K, then REV158S2) are the first two
// cases, adapted as the orchestrator ruled (ORCH28-SL01-RULING, ORCH-DECISION
// REV158S2): the REV158K case keeps its title, its plant and its three
// rows are Sol's; the export runs through the real gate as another business's
// operations:manage holder signed in to their own business, and is refused,
// writes no file and no record, reaches no store, and names none of the rows.
// The third case is their other half: the operating business's operator
// exports the archive whole. The client and delegation crossings are
// operator-only.test.ts's callers, run against every drill mode.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDatabase, createFreshDatabase } from '../support/fresh-database.ts';
import { keys } from './carried-archive.fixture.ts';
import { COMMANDS, drillKey, manager, marks, scratch } from './operator-only-commands.fixture.ts';
import {
  environment,
  operatorOnlyHooks,
  serverUrl,
  type OperatorOnlyState,
  subjects,
  token,
} from './operator-only.fixture.ts';

type Seal = {
  sealArchive: (dump: Buffer, publicKey: string) => Buffer;
  openArchive: (sealed: Buffer, privateKey: string) => Buffer;
};
type Run = { refused?: string; mode?: string; receipt?: Record<string, unknown> };
type Reach = (url: string, script: unknown, onLine?: (line: string) => unknown) => Promise<string>;
type DrillCommand = {
  runDrillCommand: (
    args: string[],
    options: { environment: Record<string, string>; reach: Reach },
  ) => Promise<Run>;
};
const load = async <T>(path: string): Promise<T> =>
  (await import(
    /* @vite-ignore */
    path
  )) as T;

const TAKEN = '2026-09-29T02:00:00.000Z';
let state: OperatorOnlyState;
const digestOf = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

/** A store holding one sealed archive of `dump`, answering as the real one does; it counts each reach. */
function plantedStore(body: Buffer): { reach: Reach; reached: () => number } {
  let reached = 0;
  const reach: Reach = (_url, _script, onLine) => {
    reached += 1;
    if (onLine === undefined) {
      const header = { id: randomUUID(), takenAt: TAKEN, bytes: body.length, parts: 1 };
      return Promise.resolve(JSON.stringify({ ...header, sha256: digestOf(body) }));
    }
    onLine(`0|${digestOf(body)}|${body.toString('hex')}`);
    return Promise.resolve('');
  };
  return { reach, reached: () => reached };
}

/** The drill command's environment for `subject`, signed in to `business`. */
async function signedIn(
  subject: string,
  business: string,
): Promise<{ env: Record<string, string>; records: string }> {
  const at = marks(manager(false));
  const env = environment(at, process.env['PATH'] ?? '', {
    OPS_ASTRO_TOKEN: await token(subject),
    OPS_ASTRO_BUSINESS: business,
    RESTORE_STORE_URL: 'postgres://drill:never@127.0.0.1:1/never',
  });
  return { env, records: at.records };
}

/** Every mode of the restore drill, as the operator-only suites run it. */
const drillModes = Object.entries(COMMANDS).filter(([name]) =>
  /restore drill|archive export|carried/u.test(name),
);

describe.skipIf(serverUrl === undefined)('S0-3e operating business only', () => {
  operatorOnlyHooks((shared) => {
    state = shared;
  });

  operatingCases1();

  // Sol's REV158S2 criterion 4 export proof, adapted the same way: its title
  // and its four planted records are Sol's.
  operatingCases2();

  operatingCases3();

  operatingCases4();
  operatingCases5();
  operatingCases6();
  operatingCases7();
  operatingCases8();
  operatingCases9();
});

function operatingCases1() {
  it('exported data stays within the operator business, client and person', async () => {
    const { sealArchive } = await load<Seal>('../../scripts/ops/archive-seal.mjs');
    const otherRows = ['another-business-record', 'another-client-record', 'another-person-record'];
    const dump = Buffer.from(['own-business-record', ...otherRows].join('\n'));
    const store = plantedStore(sealArchive(dump, keys.publicKey));
    const file = join(mkdtempSync(join(scratch, 'export-')), 'archive.sealed');
    const { env, records } = await signedIn(subjects.betaOperator, 'beta');
    const { runDrillCommand } = await load<DrillCommand>('../../scripts/ops/restore-drill.mjs');
    const run = await runDrillCommand(['--export', file], { environment: env, reach: store.reach });
    expect(run.refused).toMatch(/operations:manage/u);
    expect(run.receipt).toBeUndefined();
    expect(store.reached()).toBe(0);
    expect(existsSync(file) || existsSync(`${file}.json`)).toBe(false);
    expect(readdirSync(records)).toStrictEqual([]);
    expect(otherRows.filter((row) => JSON.stringify(run).includes(row))).toStrictEqual([]);
    expect(run.refused).not.toMatch(/beta|alpha/u);
  });
}

function operatingCases2() {
  it('export keeps business, client and person separation', async () => {
    const allowed = `allowed-${randomUUID()}`;
    const otherBusiness = `other-business-${randomUUID()}`;
    const otherClient = `other-client-${randomUUID()}`;
    const otherPerson = `other-person-${randomUUID()}`;
    const [client, person] = [randomUUID(), randomUUID()];
    const records = [
      { business: 'beta', client, person, content: allowed },
      {
        business: randomUUID(),
        client: randomUUID(),
        person: randomUUID(),
        content: otherBusiness,
      },
      { business: 'beta', client: randomUUID(), person: randomUUID(), content: otherClient },
      { business: 'beta', client, person: randomUUID(), content: otherPerson },
    ];
    const { sealArchive } = await load<Seal>('../../scripts/ops/archive-seal.mjs');
    const store = plantedStore(sealArchive(Buffer.from(JSON.stringify(records)), keys.publicKey));
    const file = join(mkdtempSync(join(scratch, 'export-')), 'archive.sealed');
    const { env, records: kept } = await signedIn(subjects.betaOperator, 'beta');
    const { runDrillCommand } = await load<DrillCommand>('../../scripts/ops/restore-drill.mjs');
    const run = await runDrillCommand(['--export', file], { environment: env, reach: store.reach });
    expect(run.refused).toMatch(/operations:manage/u);
    expect(store.reached()).toBe(0);
    expect(existsSync(file) || existsSync(`${file}.json`)).toBe(false);
    expect(readdirSync(kept)).toStrictEqual([]);
    for (const planted of [allowed, otherBusiness, otherClient, otherPerson]) {
      expect(JSON.stringify(run)).not.toContain(planted);
    }
  });
}

function operatingCases3() {
  it("the operating business's operator exports the archive whole, and the record names no digest", async () => {
    const { sealArchive, openArchive } = await load<Seal>('../../scripts/ops/archive-seal.mjs');
    const dump = Buffer.from('own-business-record\nanother-business-record\n');
    const body = sealArchive(dump, keys.publicKey);
    const store = plantedStore(body);
    const file = join(mkdtempSync(join(scratch, 'export-')), 'archive.sealed');
    const { env, records } = await signedIn(subjects.operator, 'alpha');
    const { runDrillCommand } = await load<DrillCommand>('../../scripts/ops/restore-drill.mjs');
    const run = await runDrillCommand(['--export', file], { environment: env, reach: store.reach });
    expect(run.refused).toBeUndefined();
    expect(run.receipt).toMatchObject({ action: 'archive exported', business: 'alpha' });
    expect(openArchive(readFileSync(file), keys.privateKey)).toStrictEqual(dump);
    const log = readFileSync(join(records, 'deployments.jsonl'), 'utf8');
    expect(log).not.toContain(digestOf(body));
    expect(JSON.stringify(run)).not.toContain(digestOf(body));
  });

  it.each(drillModes)(
    "S0-3 isolation: %s, run by another business's operations:manage holder in their own business, is refused before it acts and learns nothing",
    async (_name, command) => {
      const fake = manager(false);
      const at = marks(fake);
      const env = environment(at, fake.path, {
        OPS_ASTRO_TOKEN: await token(subjects.betaOperator),
        OPS_ASTRO_BUSINESS: 'beta',
      });
      const result = command(env, at);
      expect(result.status, result.out).toBe(1);
      expect(result.out).toMatch(/REFUSED: .*operations:manage/u);
      expect(result.out).not.toMatch(/alpha|beta|"outcome"|archive exported/u);
      expect(readdirSync(at.records)).toStrictEqual([]);
    },
  );
}

function operatingCases4() {
  it('another business manager cannot choose the operating business for export', async () => {
    const { sealArchive } = await load<Seal>('../../scripts/ops/archive-seal.mjs');
    const store = plantedStore(sealArchive(Buffer.from('another-business-record'), keys.publicKey));
    const file = join(mkdtempSync(join(scratch, 'sol-override-')), 'archive.sealed');
    const { env, records } = await signedIn(subjects.betaOperator, 'beta');
    env['OPS_ASTRO_OPERATING_BUSINESS'] = 'beta';
    const { runDrillCommand } = await load<DrillCommand>('../../scripts/ops/restore-drill.mjs');
    const run = await runDrillCommand(['--export', file], { environment: env, reach: store.reach });
    expect(run.refused).toBeDefined();
    expect(store.reached()).toBe(0);
    expect(existsSync(file) || existsSync(`${file}.json`)).toBe(false);
    expect(readdirSync(records)).toStrictEqual([]);
  });
}

function operatingCases6() {
  it('with no operating business written at installation, every drill mode is refused before its sign-in is looked at', async () => {
    const signIn = await token(subjects.operator);
    const admin = state.db.admin;
    await admin.execute(
      'alter table ops.operating_business disable trigger operating_business_fixed',
    );
    await admin.execute('delete from ops.operating_business');
    try {
      for (const [name, command] of drillModes) {
        const at = marks(manager(false));
        const env = environment(at, process.env['PATH'] ?? '', {
          OPS_ASTRO_TOKEN: signIn,
          // A value the operator's environment sets appoints nothing.
          OPS_ASTRO_OPERATING_BUSINESS: 'alpha',
          RESTORE_KEY_FILE: drillKey(),
        });
        const result = command(env, at);
        expect(result.status, `${name}: ${result.out}`).toBe(1);
        expect(result.out).toMatch(/the installation has no operating business/u);
        expect(readdirSync(at.records)).toStrictEqual([]);
      }
    } finally {
      await admin.execute('insert into ops.operating_business (operating_business) values ($1)', [
        state.alphaBusiness,
      ]);
      await admin.execute(
        'alter table ops.operating_business enable trigger operating_business_fixed',
      );
    }
  });
}

function operatingCases7() {
  it('the operating business is installation state: the tenancy role can neither read nor write it, and once written it is never changed or removed', async () => {
    const tenancy = state.db.app;
    for (const statement of [
      'select operating_business from ops.operating_business',
      'insert into ops.operating_business (operating_business) select id from public.businesses',
      'update ops.operating_business set written_at = now()',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal after the other
      await expect(
        tenancy.withBusiness(state.alphaBusiness as never, async (tx) => await tx.query(statement)),
        statement,
      ).rejects.toMatchObject({ code: '42501' });
    }
    const admin = state.db.admin;
    for (const statement of [
      'update ops.operating_business set operating_business = operating_business',
      'delete from ops.operating_business',
      'truncate ops.operating_business',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal after the other
      await expect(admin.execute(statement), statement).rejects.toMatchObject({ code: '42501' });
    }
    const rows = await admin.execute<{ n: number }>(
      'select count(*)::int as n from ops.operating_business',
    );
    expect(rows[0]?.n).toBe(1);
  });
}

function operatingCases8() {
  it('Sol proof, criterion 4: redirecting the admin URL cannot appoint another business', async () => {
    const [beta] = await state.db.admin.execute<{ id: string }>(
      "select id::text from public.businesses where key = 'beta'",
    );
    expect(beta).toBeDefined();
    const fake = await createEmptyDatabase({ part: 's03fake' });
    try {
      await fake.admin.execute('create schema ops');
      await fake.admin.execute('create table public.businesses (id uuid primary key, key text)');
      await fake.admin.execute('create table ops.operating_business (operating_business uuid)');
      await fake.admin.execute('insert into public.businesses (id, key) values ($1, $2)', [
        beta?.id,
        'beta',
      ]);
      await fake.admin.execute('insert into ops.operating_business values ($1)', [beta?.id]);
      const { sealArchive, openArchive } = await load<Seal>('../../scripts/ops/archive-seal.mjs');
      const plant = `alpha-record-${randomUUID()}`;
      const store = plantedStore(sealArchive(Buffer.from(plant), keys.publicKey));
      const file = join(mkdtempSync(join(scratch, 'export-')), 'archive.sealed');
      const { env, records } = await signedIn(subjects.betaOperator, 'beta');
      const fakeUrl = new URL(serverUrl ?? '');
      fakeUrl.pathname = `/${fake.name}`;
      env['DATABASE_ADMIN_URL'] = fakeUrl.toString();
      const { runDrillCommand } = await load<DrillCommand>('../../scripts/ops/restore-drill.mjs');
      const run = await runDrillCommand(['--export', file], {
        environment: env,
        reach: store.reach,
      });
      const exported = existsSync(file)
        ? openArchive(readFileSync(file), keys.privateKey).toString('utf8')
        : '';
      expect.soft(run.refused).toBeDefined();
      expect.soft(exported).not.toContain(plant);
      expect.soft(store.reached()).toBe(0);
      expect.soft(existsSync(file)).toBe(false);
      expect.soft(readdirSync(records)).toStrictEqual([]);
      expect.soft(JSON.stringify(run)).not.toContain(plant);
    } finally {
      await fake.drop();
    }
  });
}

function operatingCases5() {
  it('another business cannot appoint itself as the operating business', async () => {
    const { sealArchive } = await load<Seal>('../../scripts/ops/archive-seal.mjs');
    const plant = `alpha-record-${randomUUID()}`;
    const store = plantedStore(sealArchive(Buffer.from(plant), keys.publicKey));
    const file = join(mkdtempSync(join(scratch, 'export-')), 'archive.sealed');
    const { env, records } = await signedIn(subjects.betaOperator, 'beta');
    env['OPS_ASTRO_OPERATING_BUSINESS'] = 'beta';
    const { runDrillCommand } = await load<DrillCommand>('../../scripts/ops/restore-drill.mjs');
    const run = await runDrillCommand(['--export', file], { environment: env, reach: store.reach });
    expect(run.refused).toBeDefined();
    expect(store.reached()).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(records)).toStrictEqual([]);
    expect(JSON.stringify(run)).not.toContain(plant);
  });
}

function operatingCases9() {
  it('Sol proof, criterion 4: replacing the operating-business database cannot authorise another business export', async () => {
    const [beta] = await state.db.admin.execute<{ id: string }>(
      "select id::text from public.businesses where key = 'beta'",
    );
    expect(beta).toBeDefined();
    const otherInstallation = await createFreshDatabase({ part: 's03e_swap' });
    try {
      await otherInstallation.admin.execute(
        'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $3)',
        [beta?.id, 'beta', 'Beta'],
      );
      await otherInstallation.admin.execute(
        'insert into ops.operating_business (operating_business) values ($1)',
        [beta?.id],
      );
      const otherAdminUrl = new URL(serverUrl as string);
      otherAdminUrl.pathname = `/${otherInstallation.name}`;
      const { sealArchive } = await load<Seal>('../../scripts/ops/archive-seal.mjs');
      const store = plantedStore(sealArchive(Buffer.from('alpha-record'), keys.publicKey));
      const file = join(mkdtempSync(join(scratch, 'sol-db-swap-')), 'archive.sealed');
      const { env, records } = await signedIn(subjects.betaOperator, 'beta');
      env['DATABASE_ADMIN_URL'] = otherAdminUrl.toString();
      const { runDrillCommand } = await load<DrillCommand>('../../scripts/ops/restore-drill.mjs');
      const run = await runDrillCommand(['--export', file], {
        environment: env,
        reach: store.reach,
      });
      expect(run.refused).toBeDefined();
      expect(store.reached()).toBe(0);
      expect(existsSync(file)).toBe(false);
      expect(readdirSync(records)).toStrictEqual([]);
    } finally {
      await otherInstallation.drop();
    }
  });
}
