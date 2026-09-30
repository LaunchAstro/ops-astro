// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 J: an automation occurrence's run, created by the worker as a system
// write (ORCH36 ruling, option B). The run lands on a new task accepted by the
// standing approval; it is one run per occurrence, held by the database; its
// definition reference names the definition version; a revoked, ended or
// superseded approval or a revoked version writes nothing; and the write is
// audited naming the definition, its version and its approver. Who may write
// it, pickup and the three crossings: `aw-01-occurrence-run-isolation`.

import { createHash, randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  startOccurrenceRun,
  type OccurrenceAuthority,
} from '../../packages/core-commands/src/index.ts';
import { racer, rows, scalar } from './schedules-harness.ts';
import {
  DIGEST,
  authorityFor,
  codeOf,
  footprint,
  noDatabase,
  start,
  useOccurrenceWorld,
  w,
} from './occurrence-run-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useOccurrenceWorld('aw01occ');

const runsFor = async (occurrenceId: string): Promise<number> =>
  await scalar(
    w.s,
    `select count(*)::text as n from public.planned_runs where origin_occurrence_id = $1`,
    [occurrenceId],
  );

it('AW-01 occurrence run: one occurrence starts one run on a new accepted task, pinned to its version', async () => {
  const occurrenceId = randomUUID();
  const authority = authorityFor(w.s);
  const started = await start(w.s, occurrenceId, authority, w.worker);
  if (!started.ok) throw new Error(`refused ${started.refusal.code}`);
  expect(started.value.replayed).toBe(false);
  const [run] = await rows<Record<string, unknown>>(
    w.s,
    `select task_id, lineage_id, version_id, state, origin_occurrence_id,
            origin_definition_id, origin_approved_by_actor_id, business_id
       from public.planned_runs where id = $1`,
    [started.value.runId],
  );
  expect(run).toStrictEqual({
    task_id: started.value.taskId,
    lineage_id: null,
    version_id: null,
    state: 'planned',
    origin_occurrence_id: occurrenceId,
    origin_definition_id: authority.definitionId,
    origin_approved_by_actor_id: authority.approverActorId,
    business_id: w.s.business,
  });
  const [task] = await rows<{ readonly data: Record<string, unknown> }>(
    w.s,
    `select data from public.records where business_id = $1 and id = $2`,
    [w.s.business, started.value.taskId],
  );
  expect(task?.data).toMatchObject({
    title: authority.title,
    source: 'system:automation',
    intake_state: 'accepted',
  });
  expect(task?.data).not.toHaveProperty('client');
  const [pin] = await rows<Record<string, unknown>>(
    w.s,
    `select ref_kind, definition_version_id, content_digest, content_size::text as size,
            pinned_by_actor_id, path
       from public.run_definition_pins where business_id = $1 and run_id = $2`,
    [w.s.business, started.value.runId],
  );
  expect(pin).toStrictEqual({
    ref_kind: 'definition_version',
    definition_version_id: authority.definitionVersionId,
    content_digest: DIGEST,
    size: '42',
    pinned_by_actor_id: w.worker,
    path: null,
  });
});

it('AW-01 occurrence run: once per occurrence, replayed and raced', async () => {
  const occurrenceId = randomUUID();
  const authority = authorityFor(w.s);
  const first = await start(w.s, occurrenceId, authority, w.worker);
  const again = await start(w.s, occurrenceId, authority, w.worker);
  if (!first.ok || !again.ok) throw new Error('an occurrence run was refused');
  expect(again.value).toStrictEqual({ ...first.value, replayed: true });
  expect(await runsFor(occurrenceId)).toBe(1);
  // Two backends at once, several times over: one run and one task each time.
  const [left, right] = [racer(w.s), racer(w.s)];
  const race = async () => {
    const raced = randomUUID();
    const before = await footprint();
    const answers = await Promise.all([
      start(w.s, raced, authority, w.worker, left),
      start(w.s, raced, authority, w.worker, right),
    ]);
    const after = await footprint();
    return {
      runIds: new Set(answers.map((answer) => (answer.ok ? answer.value.runId : codeOf(answer))))
        .size,
      runs: after.runs - before.runs,
      tasks: after.records - before.records,
    };
  };
  for (let round = 0; round < 5; round += 1) {
    // Sequential: each round is its own race.
    // eslint-disable-next-line no-await-in-loop
    expect(await race()).toStrictEqual({ runIds: 1, runs: 1, tasks: 1 });
  }
  await Promise.all([left.close(), right.close()]);
});

it('AW-01 occurrence run: one run per occurrence is held by the database, past the code', async () => {
  const occurrenceId = randomUUID();
  const first = await start(w.s, occurrenceId, authorityFor(w.s), w.worker);
  if (!first.ok) throw new Error(`refused ${first.refusal.code}`);
  await expect(
    w.s.db.admin.execute(
      `insert into public.planned_runs (business_id, id, task_id, origin_occurrence_id)
       values ($1, $2, $3, $4)`,
      [w.s.business, randomUUID(), first.value.taskId, occurrenceId] as never,
    ),
  ).rejects.toThrow(/planned_runs_occurrence_idx/u);
  // A run with an origin and a plan version at once is no run at all.
  const [plan] = await rows<Record<string, string>>(
    w.s,
    `select lineage_id, version_id, task_id from public.planned_runs
      where business_id = $1 and version_id is not null limit 1`,
    [w.s.business],
  );
  await expect(
    w.s.db.admin.execute(
      `insert into public.planned_runs (business_id, id, lineage_id, version_id, task_id, origin_occurrence_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        w.s.business,
        randomUUID(),
        plan?.['lineage_id'],
        plan?.['version_id'],
        plan?.['task_id'],
        randomUUID(),
      ] as never,
    ),
  ).rejects.toThrow(/planned_runs_one_origin/u);
});

const REFUSALS: readonly (readonly [Partial<OccurrenceAuthority>, string])[] = [
  [{ approvalState: 'revoked' }, 'APPROVAL_NOT_STANDING'],
  [{ approvalState: 'ended' }, 'APPROVAL_NOT_STANDING'],
  [{ approvalState: 'superseded' }, 'APPROVAL_NOT_STANDING'],
  [{ approverActorId: randomUUID() }, 'APPROVAL_NOT_STANDING'],
  [{ versionState: 'revoked' }, 'DEFINITION_REVOKED'],
  [{ contentDigest: 'not-a-digest' }, 'DEFINITION_UNAVAILABLE'],
  [{ contentSize: -1 }, 'DEFINITION_UNAVAILABLE'],
  [{ contentSize: 1.5 }, 'DEFINITION_UNAVAILABLE'],
  [{ definitionVersionId: 'v1' }, 'DEFINITION_UNAVAILABLE'],
  [{ definitionId: '' }, 'DEFINITION_UNAVAILABLE'],
  [{ clientId: 'client one' }, 'DEFINITION_UNAVAILABLE'],
  [{ title: '' }, 'DEFINITION_UNAVAILABLE'],
];

const refusedWith = async (overrides: Partial<OccurrenceAuthority>) => {
  const before = await footprint();
  const refused = await start(w.s, randomUUID(), authorityFor(w.s, overrides), w.worker);
  expect(await footprint(), JSON.stringify(overrides)).toStrictEqual(before);
  return codeOf(refused);
};

it('AW-01 occurrence run: a revoked, ended or superseded approval, or a revoked version, writes nothing', async () => {
  for (const [overrides, code] of REFUSALS) {
    // Sequential: each refusal is measured against the footprint before it.
    // eslint-disable-next-line no-await-in-loop
    expect(await refusedWith(overrides), JSON.stringify(overrides)).toBe(code);
  }
});

const unknownWith = async (occurrenceId: string) => {
  const before = await footprint();
  const unknown = await start(w.s, occurrenceId, undefined, w.worker);
  expect(await footprint()).toStrictEqual(before);
  return codeOf(unknown);
};

it('AW-01 occurrence run: an unknown or malformed occurrence starts nothing', async () => {
  for (const occurrenceId of [randomUUID(), 'occurrence-1', '', `${randomUUID()} `]) {
    // Sequential: each is measured against the footprint before it.
    // eslint-disable-next-line no-await-in-loop
    expect(await unknownWith(occurrenceId), occurrenceId).toBe('OCCURRENCE_UNKNOWN');
  }
  // A malformed id never reaches the reader.
  let asked = 0;
  const refused = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) =>
      await startOccurrenceRun(tx, { occurrenceId: 'x', workerActorId: w.worker }, async () => {
        asked += 1;
        return await Promise.resolve(authorityFor(w.s));
      }),
  );
  expect([codeOf(refused), asked]).toStrictEqual(['OCCURRENCE_UNKNOWN', 0]);
});

it('AW-01 occurrence run: audited as a system write naming the definition, its version and its approver', async () => {
  const occurrenceId = randomUUID();
  const authority = authorityFor(w.s);
  const started = await start(w.s, occurrenceId, authority, w.worker);
  if (!started.ok) throw new Error(`refused ${started.refusal.code}`);
  const named = {
    occurrenceId,
    runId: started.value.runId,
    taskId: started.value.taskId,
    definitionId: authority.definitionId,
    definitionVersionId: authority.definitionVersionId,
    approvalId: authority.approvalId,
    approverActorId: authority.approverActorId,
  };
  const events = async () =>
    await rows<Record<string, unknown>>(
      w.s,
      `select actor_id, outcome, payload_digest, attempted from public.audit_events
        where business_id = $1 and command = 'occurrence.run_start' and subject_record_id = $2`,
      [w.s.business, started.value.taskId],
    );
  const expected = [
    {
      actor_id: w.worker,
      outcome: 'applied',
      payload_digest: createHash('sha256').update(JSON.stringify(named)).digest('hex'),
      attempted: null,
    },
  ];
  expect(await events()).toStrictEqual(expected);
  // A replay writes no second event.
  await start(w.s, occurrenceId, authority, w.worker);
  expect(await events()).toStrictEqual(expected);
});
