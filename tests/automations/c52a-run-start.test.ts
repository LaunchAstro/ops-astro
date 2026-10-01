// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's run start (U36, #483 and #484): after dispatch rechecks the
// activation and its standing approval under the activation's lock, the
// worker starts the occurrence's run through AW-01 J's write, with the
// approval and version facts read from C52-A's own rows. The recheck's
// refusals are in `c52a-firing.test.ts`; AW-01 J's own refusals, the agent
// under a live delegation included, are in `aw-01-occurrence-run*.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOccurrenceRun } from '../../packages/core-commands/src/index.ts';
import {
  dispatchOccurrence,
  readOccurrenceFacts,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { DIGEST, createAutomationWorld, insertWorker, type AutomationWorld } from './world.ts';
import { firingOf, occurrenceOf, runFootprint, starter, type Firing } from './firing.ts';

const serverUrl = databaseUrlFromEnvironment();

interface RunRow {
  readonly id: string;
  readonly task_id: string;
  readonly origin_definition_id: string;
  readonly origin_approved_by_actor_id: string;
  readonly version_id: string | null;
  readonly ref_kind: string;
  readonly definition_version_id: string;
  readonly content_digest: string;
  readonly content_size: string;
  readonly pinned_by_actor_id: string;
  readonly title: string;
  readonly intake_state: string;
  readonly source: string;
  readonly has_client: boolean;
}

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C52-A run start', () => {
  let w: AutomationWorld;
  let f: Firing;

  beforeAll(async () => {
    w = await createAutomationWorld('c52r');
    f = firingOf(w);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  const runOf = async (occurrenceId: string): Promise<readonly RunRow[]> =>
    await w.db.admin.execute<RunRow>(
      `select r.id, r.task_id, r.origin_definition_id, r.origin_approved_by_actor_id, r.version_id,
              p.ref_kind, p.definition_version_id, p.content_digest, p.content_size::text,
              p.pinned_by_actor_id, t.data->>'title' as title,
              t.data->>'intake_state' as intake_state, t.data->>'source' as source,
              t.data ? 'client' as has_client
         from public.planned_runs r
         join public.run_definition_pins p on p.business_id = r.business_id and p.run_id = r.id
         join public.records t on t.business_id = r.business_id and t.id = r.task_id
        where r.origin_occurrence_id = $1`,
      [occurrenceId],
    );

  const inBravo = async <T>(run: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await w.db.app.withBusiness(w.bravo, run);

  it('C52-A approved occurrence starts one run: the worker writes the run, its task, its definition pin and one audit event, on the exact pinned version', async () => {
    const before = await runFootprint(w);
    const { version, activation } = await f.approved();
    const occurrence = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const sent = await f.dispatch(occurrence.id, starter(w.worker).start);
    if (sent.kind !== 'dispatched') throw new Error(`the dispatch answered ${sent.kind}`);
    expect(sent.dispatch.outcome).toBe('started');
    const [run, ...more] = await runOf(occurrence.id);
    expect(more).toEqual([]);
    expect(run).toEqual({
      id: sent.dispatch.runId,
      task_id: run?.task_id,
      origin_definition_id: w.definition,
      origin_approved_by_actor_id: w.admin.actorId,
      version_id: null,
      ref_kind: 'definition_version',
      definition_version_id: version.id,
      content_digest: DIGEST,
      content_size: '1234',
      pinned_by_actor_id: w.worker,
      title: `Weekly report ${w.canary}`,
      intake_state: 'accepted',
      source: 'system:automation',
      has_client: false,
    });
    expect(await runFootprint(w)).toEqual({
      runs: before.runs + 1,
      pins: before.pins + 1,
      tasks: before.tasks + 1,
      audit: before.audit + 1,
    });
    expect(
      await w.count(
        `select count(*) as n from public.audit_events
          where command = 'occurrence.run_start' and actor_id = $1 and subject_record_id = $2`,
        [w.worker, run?.task_id],
      ),
    ).toBe(1);
  });

  it('C33 definition reference: a run started from an activation names its definition version in its pin, and an earlier run keeps the version it started on', async () => {
    const first = await f.approved();
    const early = occurrenceOf(await w.claim(first.activation.id, { dueAt: f.nextDue() }));
    await f.dispatch(early.id, starter(w.worker).start);
    const newer = await w.release(['scheduled']);
    const adopted = await f.adopt(first.activation, newer);
    const late = occurrenceOf(await w.claim(adopted.activation.id, { dueAt: f.nextDue() }));
    await f.dispatch(late.id, starter(w.worker).start);
    expect((await runOf(early.id)).map((run) => run.definition_version_id)).toEqual([
      first.version.id,
    ]);
    expect((await runOf(late.id)).map((run) => run.definition_version_id)).toEqual([newer.id]);
  });

  it('C52-A run start refused: a person, another business’s worker and a stopped worker start nothing and record no dispatch; the worker then starts it', async () => {
    const { activation } = await f.approved();
    const occurrence = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const stopped = await insertWorker(w.db, w.alpha, false);
    const before = await runFootprint(w);
    const refused = await Promise.all(
      [w.admin.actorId, w.bravoWorker, stopped].map(
        async (caller) => await f.dispatch(occurrence.id, starter(caller).start),
      ),
    );
    expect(refused.map((one) => one.kind === 'refused' && one.code)).toEqual(
      Array.from({ length: 3 }, () => 'WORKER_REQUIRED'),
    );
    expect(await runFootprint(w)).toEqual(before);
    const dispatches =
      'select count(*) as n from public.occurrence_dispatches where occurrence_id = $1';
    expect(await w.count(dispatches, [occurrence.id])).toBe(0);
    const sent = await f.dispatch(occurrence.id, starter(w.worker).start);
    expect(sent.kind === 'dispatched' && sent.dispatch.outcome).toBe('started');
    expect(await runOf(occurrence.id)).toHaveLength(1);
  });

  const startDirectly = async (business: string, occurrenceId: string, worker: string) =>
    await w.db.app.withBusiness(business, async (tx) => {
      const started = await startOccurrenceRun(
        tx,
        { occurrenceId, workerActorId: worker },
        readOccurrenceFacts,
      );
      return started.ok ? 'applied' : started.refusal.code;
    });

  it('C52-A run start rechecks the approval: started past dispatch on an occurrence whose approval was revoked, ended or superseded, the run is refused and nothing is written', async () => {
    const revoked = await f.approved();
    const ended = await f.approved();
    const superseded = await f.approved();
    const held = await Promise.all(
      [revoked, ended, superseded].map(async ({ activation }) =>
        occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() })),
      ),
    );
    await f.revoke(revoked.approval.id);
    await f.turnOff(ended.activation.id);
    await f.adopt(superseded.activation, await w.release(['scheduled']));
    const before = await runFootprint(w);
    const answers = await Promise.all(
      held.map(async (occurrence) => await startDirectly(w.alpha, occurrence.id, w.worker)),
    );
    expect(answers).toEqual(Array.from({ length: 3 }, () => 'APPROVAL_NOT_STANDING'));
    expect(await runFootprint(w)).toEqual(before);
  });

  it('C52-A run start isolation: another business neither starts nor sees the run, its task, its canary title or its audit, and the task names no client', async () => {
    const { activation } = await f.approved();
    const occurrence = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const bravo = starter(w.bravoWorker);
    expect(await inBravo((tx) => dispatchOccurrence(tx, occurrence.id, bravo.start))).toEqual({
      kind: 'unknown',
    });
    expect(bravo.runs).toEqual([]);
    expect(await startDirectly(w.bravo, occurrence.id, w.bravoWorker)).toBe('OCCURRENCE_UNKNOWN');
    expect(await runOf(occurrence.id)).toEqual([]);
    const sent = await f.dispatch(occurrence.id, starter(w.worker).start);
    expect(sent.kind === 'dispatched' && sent.dispatch.outcome).toBe('started');
    const [run] = await runOf(occurrence.id);
    expect(run?.has_client).toBe(false);
    const seen = await inBravo(
      async (tx) =>
        await tx.query<{ readonly runs: string; readonly tasks: string; readonly audit: string }>(
          `select (select count(*) from public.planned_runs where origin_occurrence_id = $1)::text as runs,
                  (select count(*) from public.records where data->>'title' like '%' || $2 || '%')::text as tasks,
                  (select count(*) from public.audit_events where command = 'occurrence.run_start')::text as audit`,
          [occurrence.id, w.canary],
        ),
    );
    expect(seen).toEqual([{ runs: '0', tasks: '0', audit: '0' }]);
    // The audit event carries a digest, never the canary title, in any business.
    expect(
      await w.count(
        `select count(*) as n from public.audit_events a where row_to_json(a)::text like '%' || $1 || '%'`,
        [w.canary],
      ),
    ).toBe(0);
  });
});
