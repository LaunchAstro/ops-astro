// SPDX-License-Identifier: AGPL-3.0-only
//
// `onboarding.start` reads that the client is here and has no onboarding
// (its claim on the unique key), then lays out one task per template step and
// writes an applied event on each beside its own (`Applied.carried`). Each
// case puts a second connection's change at one of those steps: a competing
// claim, a task moved to another client or a step moved on, each held at the
// audit-chain lock uncommitted beside the start; or ends the start between
// its writes and its commit; or presents the same start again.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { claimOnboarding, ONBOARDING_TEMPLATES } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { diesAtTheAuditChain, keptBy } from '../support/dies-at-the-audit-chain.ts';
import type { Answer } from '../api/fixture.ts';
import { detail, useMoveWorld } from './c41-a-move-world.ts';

const serverUrl = databaseUrlFromEnvironment();
const STEPS = ONBOARDING_TEMPLATES['standard']?.steps.length ?? 0;

const startOf = (clientId: string) => ({
  operationId: randomUUID(),
  clientId,
  templateKey: 'standard',
});

const stepTasks = (answer: Answer): string[] =>
  (detail(answer)['steps'] as readonly { readonly taskId: string }[]).map((one) => one.taskId);

// eslint-disable-next-line max-lines-per-function -- one world, the races that share it
describe.skipIf(serverUrl === undefined)('onboarding.start laying out its step tasks', () => {
  const { the, as, onboard, done, revisionOf, race } = useMoveWorld('onbstartrace');

  const newClient = async (name: string): Promise<string> => {
    const created = await as(the.admin, 'record.create', { type: 'client', fields: { name } });
    expect(created.status).toBe(200);
    return String(detail(created)['recordId']);
  };

  /** The live tasks on the client, its onboardings, and the start's applied events in chain order. */
  const laidOut = async (clientId: string, operationId: string) => {
    const { admin } = the.controls.fixture.db;
    const [row] = await admin.execute<{ readonly tasks: number; readonly onboardings: number }>(
      `select (select count(*)::int from public.records
                where data ->> 'client' = $1 and deleted_at is null) as tasks,
              (select count(*)::int from public.onboardings where client_id = $1::uuid) as onboardings`,
      [clientId],
    );
    const events = await admin.execute<{ readonly subject: string; readonly seq: number }>(
      `select subject_record_id::text as subject, seq::int as seq from public.audit_events
        where operation_id::text = $1 and outcome = 'applied' order by seq`,
      [operationId],
    );
    const seqs = events.map((one) => Number(one.seq));
    return {
      tasks: row?.tasks,
      onboardings: row?.onboardings,
      subjects: events.map((one) => one.subject),
      together: seqs.length === 0 || (seqs.at(-1) ?? 0) - (seqs[0] ?? 0) + 1 === seqs.length,
    };
  };

  const claimed = async (clientId: string, ending: 'commit' | 'rollback') => {
    const { db, business } = the.controls.fixture;
    const claim = await hold(
      db.appUrl,
      business,
      async (tx) =>
        await claimOnboarding(tx, {
          clientId,
          templateKey: 'standard',
          templateVersion: 1,
          startedBy: the.admin.actorId,
        }),
      ending,
    );
    const body = startOf(clientId);
    const starting = as(the.admin, 'onboarding.start', body);
    try {
      await waitingOn(db.admin, 'transactionid', 'insert into public.onboardings');
    } finally {
      await claim.letGo();
    }
    return { body, answer: await starting };
  };

  it('a start that waited on a competing claim for its client lays out nothing once that claim commits', async () => {
    const clientId = await newClient('Made-up Client Claimed Meanwhile');
    const { body, answer } = await claimed(clientId, 'commit');
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('TRANSITION_NOT_PERMITTED');
    expect(await laidOut(clientId, body.operationId)).toEqual({
      tasks: 0,
      onboardings: 1,
      subjects: [],
      together: true,
    });
  });

  it('a start that waited on a competing claim that rolled back lays out each task with its own applied event', async () => {
    const clientId = await newClient('Made-up Client Claim Rolled Back');
    const { body, answer } = await claimed(clientId, 'rollback');
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(await laidOut(clientId, body.operationId)).toEqual({
      tasks: STEPS,
      onboardings: 1,
      subjects: [clientId, ...stepTasks(answer)],
      together: true,
    });
  });

  it('a start raced with a step task moved to its client keeps its events on its own tasks, together in the chain', async () => {
    const other = await onboard('Made-up Client Losing A Task');
    const welcome = String(other.get('welcome-email'));
    const clientId = await newClient('Made-up Client Gaining A Task');
    const body = startOf(clientId);
    const move = { recordId: welcome, expectedRevision: await revisionOf(welcome) };
    const [started, moved] = await race(
      { name: 'onboarding.start', body },
      { name: 'task.set_party', body: { ...move, fields: { client: clientId } } },
    );
    expect([started.status, moved.status]).toEqual([200, 200]);
    expect(await laidOut(clientId, body.operationId)).toEqual({
      tasks: STEPS + 1,
      onboardings: 1,
      subjects: [clientId, ...stepTasks(started)],
      together: true,
    });
  });

  it('a start raced with another onboarding step moving on keeps one applied event per task it laid out, together in the chain', async () => {
    const other = await onboard('Made-up Client Moving On');
    const clientId = await newClient('Made-up Client Started Beside It');
    const body = startOf(clientId);
    const [started, stepped] = await race(
      { name: 'onboarding.start', body },
      {
        name: 'onboarding.step_result',
        body: { recordId: other.get('welcome-email'), outcome: 'done', result: 'sent' },
      },
    );
    expect([started.status, stepped.status]).toEqual([200, 200]);
    expect(await laidOut(clientId, body.operationId)).toEqual({
      tasks: STEPS,
      onboardings: 1,
      subjects: [clientId, ...stepTasks(started)],
      together: true,
    });
  });

  it('a start that dies after laying out its tasks leaves nothing, and the same start again lays them out once', async () => {
    const clientId = await newClient('Made-up Client Start Dies');
    const body = startOf(clientId);
    const send = async () => await as(the.admin, 'onboarding.start', body);
    const { db, business } = the.controls.fixture;
    const died = await diesAtTheAuditChain(db, business, send);
    expect(died.ended).toBe(1);
    expect(died.answer?.status).not.toBe(200);
    expect({
      laid: await laidOut(clientId, body.operationId),
      kept: await keptBy(db.admin, business, body.operationId),
    }).toEqual({
      laid: { tasks: 0, onboardings: 0, subjects: [], together: true },
      kept: { operations: 0, applied: 0, refused: 0 },
    });
    const retried = await send();
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect((await send()).body).toEqual(retried.body);
    expect(await laidOut(clientId, body.operationId)).toEqual({
      tasks: STEPS,
      onboardings: 1,
      subjects: [clientId, ...stepTasks(retried)],
      together: true,
    });
  });

  it('the same start presented again after its tasks moved on answers as before and writes no event', async () => {
    const clientId = await newClient('Made-up Client Start Repeated');
    const body = startOf(clientId);
    const first = await as(the.admin, 'onboarding.start', body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const steps = new Map(
      (detail(first)['steps'] as readonly { key: string; taskId: string }[]).map((one) => [
        one.key,
        one.taskId,
      ]),
    );
    await done(steps, 'welcome-email');
    const again = await as(the.admin, 'onboarding.start', body);
    expect(again.body).toEqual(first.body);
    expect(await laidOut(clientId, body.operationId)).toEqual({
      tasks: STEPS,
      onboardings: 1,
      subjects: [clientId, ...stepTasks(first)],
      together: true,
    });
  });
});
