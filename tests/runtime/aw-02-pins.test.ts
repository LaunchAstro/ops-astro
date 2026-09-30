// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-02: the pin slot and the stores' grants. Every case that needs an
// activated run (the plan accept activating a file, a moved file refused at
// the read, the recovery cases) is AW-04's, run there against the real accept.
// Pins here are seeded by the test's admin connection on runs a real pickup
// made: a grant test, not an activation.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { identityOf, type ReadAuditNote } from '../../packages/core-runtime/src/index.ts';
import { liveWork, type Schedules } from './schedules-harness.ts';
import {
  ENTRY,
  encode,
  fingerprint,
  leaseOf,
  noDatabase,
  readAs,
  seedPin,
  seedRead,
  sourceOf,
  sqlstate,
  useAw02World,
  w,
} from './aw-02-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw02World('aw02pins');

const DIGEST = 'a'.repeat(64);

/** Shapes the server refuses on a run with no pin: each must be the shape's own check. */
const HOSTILE: readonly (readonly [string, Record<string, unknown>])[] = [
  ['kind unknown', { ref_kind: 'file' }],
  ['kind in capitals', { ref_kind: 'Bootstrap_file' }],
  ['bootstrap with no path', { path: null }],
  ['bootstrap with no read time', { read_at: null }],
  ['bootstrap naming a version', { definition_version_id: randomUUID() }],
  ['version with a path', { ref_kind: 'definition_version', definition_version_id: randomUUID() }],
  ['version with no version', { ref_kind: 'definition_version', path: null, read_at: null }],
  ['digest in capitals', { content_digest: 'A'.repeat(64) }],
  ['digest short', { content_digest: 'a'.repeat(63) }],
  ['size negative', { content_size: -1 }],
  ['path up a level', { path: '../x.md' }],
  ['path absolute', { path: '/x.md' }],
  ['path doubled slash', { path: 'a//x.md' }],
  ['path dot segment', { path: 'a/./x.md' }],
  ['path with a tab', { path: 'a/\tx.md' }],
  ['manifest not a list', { manifest: '{}' }],
];

/** Insert one pin as the owner and roll it back: `ok`, or the SQLSTATE. */
async function tryPin(
  owner: Schedules,
  runId: string,
  columns: Record<string, unknown>,
): Promise<string> {
  const row = {
    business_id: owner.business,
    run_id: runId,
    ref_kind: 'bootstrap_file',
    path: 'x.md',
    content_digest: DIGEST,
    content_size: 1,
    read_at: new Date(),
    definition_version_id: null,
    manifest: '[]',
    manifest_digest: DIGEST,
    pinned_by_actor_id: owner.decider.actorId,
    ...columns,
  };
  const names = Object.keys(row);
  const values = names.map(
    (name, i) => `$${String(i + 1)}${name === 'manifest' ? '::text::jsonb' : ''}`,
  );
  return await sqlstate(
    async () =>
      await owner.db.admin.transaction(async (execute) => {
        await execute(
          `insert into public.run_definition_pins (${names.join(', ')})
           values (${values.join(', ')})`,
          Object.values(row),
        );
        throw Object.assign(new Error('roll back'), { code: 'ok' });
      }),
  );
}

/** The owner's attempt to keep an audit copy that is not the file it claims to be. */
async function tryCopy(digest: string, size: number): Promise<string> {
  return await sqlstate(
    async () =>
      await w.alpha.db.admin.execute(
        `insert into public.bootstrap_bytes (business_id, content_digest, content_size, bytes)
         values ($1, $2, $3, $4)`,
        [w.alpha.business, digest, size, Buffer.from('abc')],
      ),
  );
}

/** Bravo's run with its pin and ledger row taken away, so a refusal there is a shape's own. */
async function clearBravo(): Promise<string> {
  const { run_id: runId } = await leaseOf(w.bravo, w.bravoWork.picked['leaseId']);
  await w.alpha.db.admin.execute('delete from public.bootstrap_reads where business_id = $1', [
    w.bravo.business,
  ]);
  await w.alpha.db.admin.execute('delete from public.run_definition_pins where business_id = $1', [
    w.bravo.business,
  ]);
  return runId;
}

it('AW-02 pin slot: one reference slot per run, a bootstrap-file kind now and a definition version later', async () => {
  const { run_id: alphaRun } = await leaseOf(w.alpha, w.alphaWork.picked['leaseId']);
  // The slot is the run's: a second pin on the same run is refused.
  expect(await tryPin(w.alpha, alphaRun, {})).toBe('23505');
  const bravoRun = await clearBravo();
  const answers = await Promise.all(
    HOSTILE.map(async ([, columns]) => await tryPin(w.bravo, bravoRun, columns)),
  );
  expect(Object.fromEntries(HOSTILE.map(([label], i) => [label, answers[i]]))).toStrictEqual(
    Object.fromEntries(HOSTILE.map(([label]) => [label, '23514'])),
  );
  // The two shapes the slot takes (each rolled back).
  expect(await tryPin(w.bravo, bravoRun, {})).toBe('ok');
  const version = { ref_kind: 'definition_version', path: null, read_at: null };
  const versioned = await tryPin(w.bravo, bravoRun, {
    ...version,
    definition_version_id: randomUUID(),
  });
  expect(versioned).toBe('ok');
  await seedPin(w.bravo, bravoRun);
  await seedRead(w.bravo, bravoRun);
  // An audit copy that is not the file it claims to be cannot be stored.
  expect(await tryCopy(DIGEST, 3)).toBe('23514');
  expect(await tryCopy(identityOf('x', encode('abc')).digest, 4)).toBe('23514');
}, 120_000);

it('AW-02 pin slot: no ledger row and no read without the pin; nothing is resolved by name or path', async () => {
  const unpinned = await liveWork(w.alpha, 'aw02 unpinned run', 1_000);
  const lease = await leaseOf(w.alpha, unpinned.picked['leaseId']);
  const ledgerRow = await sqlstate(
    async () =>
      await w.alpha.db.admin.execute(
        `insert into public.bootstrap_reads
           (business_id, id, run_id, sequence, path, content_digest, content_size, is_entry)
         values ($1, $2, $3, 1, 'x.md', $4, 1, true)`,
        [w.alpha.business, randomUUID(), lease.run_id, DIGEST],
      ),
  );
  expect(ledgerRow).toBe('23503');
  // The file is there and the lease is live, and the read refuses without asking for it.
  const source = sourceOf(new Map([[ENTRY, encode('present')]]));
  const notes: ReadAuditNote[] = [];
  const request = {
    leaseId: String(unpinned.picked['leaseId']),
    holderActorId: lease.holder_actor_id,
    runId: lease.run_id,
    stepId: null,
    path: ENTRY,
  };
  expect(JSON.parse(await readAs(w.alpha, request, notes, source))).toMatchObject({
    code: 'DEFINITION_UNAVAILABLE',
  });
  expect(source.asked).toStrictEqual([]);
  expect(notes).toStrictEqual([]);
}, 120_000);

/** Each statement a run role must be refused, labelled. */
const REWRITES: readonly (readonly [string, string])[] = [
  [
    'update pin',
    'update public.run_definition_pins set content_size = content_size where business_id = $1',
  ],
  ['delete pin', 'delete from public.run_definition_pins where business_id = $1'],
  ['update ledger', 'update public.bootstrap_reads set sequence = sequence where business_id = $1'],
  ['delete ledger', 'delete from public.bootstrap_reads where business_id = $1'],
  ['read copy', 'select bytes from public.bootstrap_bytes where business_id = $1'],
  ['update copy', 'update public.bootstrap_bytes set bytes = bytes where business_id = $1'],
  ['delete copy', 'delete from public.bootstrap_bytes where business_id = $1'],
  ['delete a historical run', 'delete from public.planned_runs where business_id = $1'],
  [
    "rewrite a run's version",
    'update public.planned_runs set version_id = version_id where business_id = $1',
  ],
  [
    "rewrite a run's task",
    'update public.planned_runs set task_id = task_id where business_id = $1',
  ],
  [
    "rewrite a run's lineage",
    'update public.planned_runs set lineage_id = lineage_id where business_id = $1',
  ],
];

const STATE_MOVE = 'update public.planned_runs set state = state where business_id = $1';

const READS: readonly (readonly [string, string])[] = [
  ['read pin', 'select 1 from public.run_definition_pins where business_id = $1'],
  ['read ledger', 'select 1 from public.bootstrap_reads where business_id = $1'],
];

const labelled = (
  statements: readonly (readonly [string, string])[],
  answers: readonly string[],
): Record<string, string | undefined> =>
  Object.fromEntries(statements.map(([label], i) => [label, answers[i]]));

const refusedAll = (statements: readonly (readonly [string, string])[]): Record<string, string> =>
  Object.fromEntries(statements.map(([label]) => [label, '42501']));

async function asApplication(statement: string): Promise<string> {
  const own = w.alpha.business;
  return await sqlstate(
    async () =>
      await w.alpha.db.app.withBusiness(own, async (tx) => await tx.query(statement, [own])),
  );
}

async function asRole(role: string, statement: string): Promise<string> {
  return await sqlstate(
    async () =>
      await w.alpha.db.admin.transaction(async (execute) => {
        await execute(`set local role ${role}`);
        await execute(statement, [w.alpha.business]);
      }),
  );
}

async function roleAnswers(role: string): Promise<Record<string, string | undefined>> {
  const all = [...REWRITES, ...READS];
  return labelled(all, await Promise.all(all.map(async ([, text]) => await asRole(role, text))));
}

it('AW-02 immutable: no run role rewrites a pin or a ledger row, or reads the audit copy', async () => {
  const before = await fingerprint(w.alpha);
  const application = await Promise.all(REWRITES.map(async ([, t]) => await asApplication(t)));
  expect(labelled(REWRITES, application)).toStrictEqual(refusedAll(REWRITES));
  // The other run roles and the restricted login hold nothing on the stores.
  const roles = ['ops_astro_worker', 'ops_astro_broker', w.alpha.db.restrictedRole];
  const byRole = await Promise.all(roles.map(async (role) => await roleAnswers(role)));
  expect(byRole).toStrictEqual(roles.map(() => refusedAll([...REWRITES, ...READS])));
  // The application may read what it may insert, and the copy stays blind to it.
  const visible = await Promise.all(READS.map(async ([, text]) => await asApplication(text)));
  expect(visible).toStrictEqual(['ok', 'ok']);
  // A run's state is the one thing the application moves on it.
  expect(await asApplication(STATE_MOVE)).toBe('ok');
  // The evidence reads back unchanged.
  expect(await fingerprint(w.alpha)).toBe(before);
}, 120_000);
