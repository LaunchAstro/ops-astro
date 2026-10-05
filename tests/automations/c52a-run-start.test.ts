// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's run start (U36, #483 and #484): after dispatch rechecks the
// activation and its standing approval under the activation's lock, the
// worker starts the occurrence's run through AW-01 J's write, with the
// approval and version facts read from C52-A's own rows. The recheck's own
// outcomes are in `c52a-firing.test.ts`; AW-01 J's own refusals are in
// `aw-01-occurrence-run*.test.ts`.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startOccurrenceRun } from '../../packages/core-commands/src/index.ts';
import {
  dispatchOccurrence,
  readOccurrenceFacts,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { firingOf, occurrenceOf, type Firing } from './firing.ts';
import {
  finishRuns,
  insertWorker,
  prepareRuns,
  runFootprint,
  workerStarter,
  type Workers,
} from './run-start.ts';
import { DIGEST, createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

interface RunRow {
  readonly id: string;
  readonly task_id: string;
  readonly origin_definition_id: string;
  readonly origin_approved_by_actor_id: string;
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

/** Every source file under `root` (not tests, not built output). */
function sourcesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.(ts|tsx|mjs)$/u.test(path) && !path.includes('node_modules'))
    .map((path) => join(root, path));
}

describe('C52-A run start has no route', () => {
  it('an approved occurrence run start is reached by no API route, command-line verb, agent operation or wire command', () => {
    const callers = ['apps', 'packages/core-wire/src', 'packages/core-commands/src/commands']
      .flatMap((root) => sourcesUnder(root))
      .filter((path) => !path.endsWith('automation-run.ts') && !path.endsWith('occurrence-run.ts'))
      .filter((path) =>
        /occurrenceRunStarter|dispatchOccurrence|startOccurrenceRun/u.test(
          readFileSync(path, 'utf8'),
        ),
      );
    expect(callers).toEqual([]);
  });
});

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C52-A run start', () => {
  let w: AutomationWorld;
  let f: Firing;
  let k: Workers;

  beforeAll(async () => {
    w = await createAutomationWorld('c52r');
    f = firingOf(w);
    k = await prepareRuns(w);
  });

  // Each case starts under the business's run ceiling.
  beforeEach(async () => {
    await finishRuns(w, w.alpha);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  const runOf = async (occurrenceId: string): Promise<readonly RunRow[]> =>
    await w.db.admin.execute<RunRow>(
      `select r.id, r.task_id, r.origin_definition_id, r.origin_approved_by_actor_id,
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

  it('an approved occurrence starts one run: the worker writes the run, its task, its definition pin and one audit event, on the exact pinned version', async () => {
    const before = await runFootprint(w);
    const { version, activation } = await f.approved();
    const occurrence = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const sent = await f.dispatch(occurrence.id, workerStarter(k.worker).start);
    if (sent.kind !== 'dispatched') throw new Error(`the dispatch answered ${sent.kind}`);
    expect(sent.dispatch.outcome).toBe('started');
    const [run, ...more] = await runOf(occurrence.id);
    expect(more).toEqual([]);
    expect(run).toEqual({
      id: sent.dispatch.runId,
      task_id: run?.task_id,
      origin_definition_id: w.definition,
      origin_approved_by_actor_id: w.admin.actorId,
      ref_kind: 'definition_version',
      definition_version_id: version.id,
      content_digest: DIGEST,
      content_size: '1234',
      pinned_by_actor_id: k.worker,
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
        [k.worker, run?.task_id],
      ),
    ).toBe(1);
  });

  it('a run started from an activation names its definition version in its pin, and an earlier run keeps the version it started on', async () => {
    const first = await f.approved();
    const early = occurrenceOf(await w.claim(first.activation.id, { dueAt: f.nextDue() }));
    await f.dispatch(early.id, workerStarter(k.worker).start);
    const newer = await w.release(['scheduled']);
    const adopted = await f.adopt(first.activation, newer);
    const late = occurrenceOf(await w.claim(adopted.activation.id, { dueAt: f.nextDue() }));
    await f.dispatch(late.id, workerStarter(k.worker).start);
    expect((await runOf(early.id)).map((run) => run.definition_version_id)).toEqual([
      first.version.id,
    ]);
    expect((await runOf(late.id)).map((run) => run.definition_version_id)).toEqual([newer.id]);
  });

  it('an approved occurrence dispatched twice at once on separate connections starts one run, and the second answers the first', async () => {
    const { activation } = await f.approved();
    const occurrence = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const s = workerStarter(k.worker);
    const answers = await Promise.all([
      f.dispatch(occurrence.id, s.start),
      f.dispatch(occurrence.id, s.start),
    ]);
    expect(answers.map((one) => one.kind).toSorted()).toEqual(['dispatched', 'replayed']);
    const runIds = answers.map((one) => ('dispatch' in one ? one.dispatch.runId : null));
    expect(runIds[0]).toBe(runIds[1]);
    expect(await runOf(occurrence.id)).toHaveLength(1);
    expect(s.runs).toHaveLength(1);
  });

  it('a turned-off activation starts no run for an occurrence approved before it was turned off', async () => {
    const { activation } = await f.approved();
    const occurrence = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    await f.turnOff(activation.id);
    const before = await runFootprint(w);
    const s = workerStarter(k.worker);
    const sent = await f.dispatch(occurrence.id, s.start);
    expect(sent.kind === 'dispatched' && sent.dispatch).toEqual({
      occurrenceId: occurrence.id,
      outcome: 'activation_off',
      runId: null,
    });
    expect(s.runs).toEqual([]);
    expect(await runFootprint(w)).toEqual(before);
  });

  it('a run start the writer refuses (a person, another business’s worker, a stopped worker) writes nothing and records no dispatch, so the worker then starts it', async () => {
    const { activation } = await f.approved();
    const occurrence = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const stopped = await insertWorker(w.db, w.alpha, false);
    const before = await runFootprint(w);
    const refused = await Promise.all(
      [w.admin.actorId, k.bravoWorker, stopped].map(
        async (caller) => await f.dispatch(occurrence.id, workerStarter(caller).start),
      ),
    );
    expect(refused.map((one) => one.kind === 'refused' && one.code)).toEqual(
      Array.from({ length: 3 }, () => 'WORKER_REQUIRED'),
    );
    expect(await runFootprint(w)).toEqual(before);
    const dispatches =
      'select count(*) as n from public.occurrence_dispatches where occurrence_id = $1';
    expect(await w.count(dispatches, [occurrence.id])).toBe(0);
    const sent = await f.dispatch(occurrence.id, workerStarter(k.worker).start);
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

  it('a run started past dispatch on an occurrence whose approval was revoked, ended or superseded is refused and nothing is written', async () => {
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
      held.map(async (occurrence) => await startDirectly(w.alpha, occurrence.id, k.worker)),
    );
    expect(answers).toEqual(Array.from({ length: 3 }, () => 'APPROVAL_NOT_STANDING'));
    expect(await runFootprint(w)).toEqual(before);
  });

  it('another business neither starts nor sees the run, its task, its canary title or its audit, and the task names no client', async () => {
    const { activation } = await f.approved();
    const occurrence = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const bravo = workerStarter(k.bravoWorker);
    const answer = await inBravo((tx) => dispatchOccurrence(tx, occurrence.id, bravo.start));
    expect(answer).toEqual({ kind: 'unknown' });
    expect(JSON.stringify(answer)).not.toContain(w.canary);
    expect(bravo.runs).toEqual([]);
    expect(await startDirectly(w.bravo, occurrence.id, k.bravoWorker)).toBe('OCCURRENCE_UNKNOWN');
    expect(await runOf(occurrence.id)).toEqual([]);
    const sent = await f.dispatch(occurrence.id, workerStarter(k.worker).start);
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
