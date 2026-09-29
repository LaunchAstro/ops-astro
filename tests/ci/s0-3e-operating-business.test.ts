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
import { keys } from './carried-archive.fixture.ts';
import { COMMANDS, drillKey, manager, marks, scratch } from './operator-only-commands.fixture.ts';
import {
  environment,
  operatorOnlyHooks,
  serverUrl,
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
  operatorOnlyHooks(() => {});

  operatingCases1();

  // Sol's REV158S2 criterion 4 export proof, adapted the same way: its title
  // and its four planted records are Sol's.
  operatingCases2();

  operatingCases3();

  operatingCases4();
  operatingCases5();
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
  it('Sol proof, criterion 4: another business manager cannot choose the operating business for export', async () => {
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

  it('with no operating business configured, every drill mode is refused before any lookup', async () => {
    const signIn = await token(subjects.operator);
    for (const [name, command] of drillModes) {
      const at = marks(manager(false));
      const env = environment(at, process.env['PATH'] ?? '', {
        OPS_ASTRO_TOKEN: signIn,
        OPS_ASTRO_OPERATING_BUSINESS: '',
        RESTORE_KEY_FILE: drillKey(),
      });
      const result = command(env, at);
      expect(result.status, `${name}: ${result.out}`).toBe(1);
      expect(result.out).toMatch(/OPS_ASTRO_OPERATING_BUSINESS is not set/u);
      expect(readdirSync(at.records)).toStrictEqual([]);
    }
  });
}

function operatingCases5() {
  it('Sol proof, criterion 4: another business cannot appoint itself as the operating business', async () => {
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
