// SPDX-License-Identifier: AGPL-3.0-only
//
// #2351: an agent asks to delete a task, and a person confirms it in Ops Astro.
//
// `task.request_delete` records an open request, with its reason, on the
// task: an agent credential reaches it under its ticked `task:write`, and so
// does a person. `task.confirm_delete` and `task.decline_delete` are a
// person's alone (`task:decide`, never on an agent's reach): Confirm runs
// `task.delete`'s bin with its refusals, and Keep closes the request. A
// request lapses seven days after it is made, and a lapsed one does nothing.
// The business boundary and the races: `task-request-delete-races.test.ts`.

import { describe, expect, it } from 'vitest';
import { serverUrl } from './world.ts';
import { CANARY, DAY_MS, okay, openRequestWorld } from './task-request-delete-world.ts';

const w = openRequestWorld('task_request_delete_2351');
const h = w.harness;

// eslint-disable-next-line max-lines-per-function -- one world, and the cases that share it
describe.skipIf(serverUrl === undefined)('task.request_delete, confirmed by a person', () => {
  it('an agent request shows on the task, with its reason and a seven-day expiry', async () => {
    const task = await h().freshTask('a task an agent asks to delete');
    const asked = await w.ask(task.id);
    console.log(`request as an agent credential: ${asked.status} ${asked.code}`);
    okay(asked);

    const pending = await w.pendingOn(task.id);
    expect(pending?.['reason']).toBe(`${CANARY} a test task`);
    expect(pending?.['byAgent']).toBe(true);
    const days =
      (Date.parse(String(pending?.['expiresAt'])) - Date.parse(String(pending?.['requestedAt']))) /
      DAY_MS;
    expect(days).toBeCloseTo(7, 3);
    expect(await w.readCode(task.id), 'a request deletes nothing').toBe('ok');
    // The request is the team's to answer: an agent's own read of the task never carries it.
    const byAgent = await w.asCredential('task.read', { recordId: task.id });
    expect(byAgent.code, byAgent.text).toBe('ok');
    expect(byAgent.text).not.toContain('deleteRequest');
    expect(byAgent.text).not.toContain(CANARY);

    // One request at a time.
    const again = await w.ask(task.id);
    expect(again.code).toBe('DELETE_REQUEST_PENDING');
  });

  it('refuses a request with no reason or one too long', async () => {
    const task = await h().freshTask('a task asked about with no reason');
    for (const reason of ['', '   ', 'x'.repeat(501), 7]) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await w.ask(task.id, reason as string);
      expect(refused.code, `reason ${JSON.stringify(reason).slice(0, 12)}`).toBe(
        'FIELD_VALUE_INVALID',
      );
    }
    expect(await w.pendingOn(task.id)).toBeNull();
    // S2362-1: the length is the trimmed reason's, so padding never refuses a valid one.
    const padded = ` ${'x'.repeat(500)} `;
    okay(await w.ask(task.id, padded), 'a padded 500-character reason');
    expect((await w.pendingOn(task.id))?.['reason']).toBe('x'.repeat(500));
  });

  it("Confirm deletes it, soft, restorable and audited, as the person's own act", async () => {
    const task = await h().freshTask('a task confirmed for deletion');
    okay(await w.ask(task.id));

    const confirmed = await w.answer('task.confirm_delete', task.id);
    console.log(`confirm as the owner: ${confirmed.status} ${confirmed.code}`);
    okay(confirmed);
    const batchId = (confirmed.body['detail'] as Record<string, unknown>)['batchId'];
    expect(typeof batchId).toBe('string');
    expect(await w.readCode(task.id)).toBe('NOT_FOUND');

    const rows = await h().world.db.admin.execute<{ readonly by: string | null }>(
      `select deleted_by_actor_id::text as by from public.records where id = $1`,
      [task.id],
    );
    expect(rows, 'deleted by the person, never the agent').toStrictEqual([
      { by: h().world.ada.actorId },
    ]);
    const audit = await h().world.db.admin.execute<{ readonly command: string }>(
      `select command from public.audit_events
        where subject_record_id = $1 and outcome = 'applied' order by seq`,
      [task.id],
    );
    expect(audit.map((row) => row.command)).toStrictEqual([
      'task.create',
      'task.request_delete',
      'task.confirm_delete',
    ]);

    expect((await h().asPerson('task.restore', { batchId })).code).toBe('ok');
    expect(await w.readCode(task.id)).toBe('ok');
    expect(await w.pendingOn(task.id), 'the confirmed request is closed').toBeNull();
  });

  it('Keep closes the request and leaves the task', async () => {
    const task = await h().freshTask('a task kept');
    okay(await w.ask(task.id));
    const kept = await w.answer('task.decline_delete', task.id);
    okay(kept);
    expect(await w.pendingOn(task.id)).toBeNull();
    expect(await w.readCode(task.id)).toBe('ok');
    const late = await w.answer('task.confirm_delete', task.id);
    expect(late.code, 'nothing left to confirm').toBe('DELETE_REQUEST_NOT_PENDING');
    expect(await w.readCode(task.id)).toBe('ok');
  });

  it('a stale answer to request A never answers its replacement B (#2362)', async () => {
    const task = await h().freshTask('a task asked about twice');
    okay(await w.ask(task.id, `${CANARY} request A`), 'the agent opens A');
    const a = await w.requestIdOf(task.id);
    okay(await w.answer('task.decline_delete', task.id, { requestId: a }), 'Keep answers A');
    okay(await w.ask(task.id, `${CANARY} request B`), 'the agent opens B');
    const b = await w.requestIdOf(task.id);
    expect(b).not.toBe(a);
    // A's Confirm, still on the person's screen, arrives late: the task's revision is unchanged.
    for (const name of ['task.confirm_delete', 'task.decline_delete'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const stale = await w.answer(name, task.id, { requestId: a });
      console.log(`a stale ${name} of A once B is open: ${stale.status} ${stale.code}`);
      expect(stale.code, `a stale ${name} of A`).toBe('DELETE_REQUEST_NOT_PENDING');
    }
    expect(await w.readCode(task.id), 'the task is not deleted').toBe('ok');
    expect((await w.pendingOn(task.id))?.['id'], 'B still waits for its own answer').toBe(b);
    const malformed = await w.answer('task.confirm_delete', task.id, { requestId: 'not-an-id' });
    expect(malformed.code).toBe('FIELD_VALUE_INVALID');
    okay(await w.answer('task.decline_delete', task.id, { requestId: b }), 'B answered by its id');
  });

  it('refuses a request on a task in the bin, and opens none (#2362)', async () => {
    const task = await h().freshTask('a task already in the bin');
    okay(await h().asPerson('task.delete', { recordId: task.id, expectedRevision: task.revision }));
    expect(await w.readCode(task.id)).toBe('NOT_FOUND');
    const asked = await w.ask(task.id);
    console.log(`request on a task in the bin: ${asked.status} ${asked.code}`);
    expect(asked.code).toBe('NOT_FOUND');
    expect(await w.requestIdOf(task.id), 'no request row').toBe('');
  });

  it('an agent cannot confirm its own request, nor delete or keep', async () => {
    const task = await h().freshTask('a task an agent tries to finish deleting');
    okay(await w.ask(task.id));
    const body = { recordId: task.id, expectedRevision: await w.revisionOf(task.id) };
    for (const name of ['task.confirm_delete', 'task.decline_delete', 'task.delete'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const byCredential = await w.asCredential(name, body);
      console.log(`${name} as the agent credential: ${byCredential.status} ${byCredential.code}`);
      expect(byCredential.status, name).toBe(403);
      expect(byCredential.code).toBe('DELEGATION_EXCLUDES_OPERATION');
      // eslint-disable-next-line no-await-in-loop
      const byPickup = await h().asAgent(name, body);
      expect(byPickup.status, `${name} by a pickup`).toBe(403);
    }
    expect(await w.readCode(task.id)).toBe('ok');
    expect(await w.pendingOn(task.id), 'still waiting for a person').not.toBeNull();
  });

  it('a pickup agent asks nothing outside its own task', async () => {
    const task = await h().freshTask('a task outside a pickup');
    const refused = await h().asAgent('task.request_delete', {
      recordId: task.id,
      expectedRevision: task.revision,
      reason: 'not mine',
    });
    expect(refused.status).toBe(403);
    expect(await w.pendingOn(task.id)).toBeNull();
  });

  it('refuses a task with money or run history at Confirm, and keeps the request', async () => {
    const { subject } = await h().approvedReservation();
    okay(await w.ask(subject.id));
    const refused = await w.answer('task.confirm_delete', subject.id);
    console.log(`confirm on a task with a reservation: ${refused.status} ${refused.code}`);
    expect(refused.code).toBe('TASK_NOT_DELETABLE');
    expect(await w.readCode(subject.id)).toBe('ok');
    expect(await w.pendingOn(subject.id), 'Keep is still there to close it').not.toBeNull();
  });

  it('an expired request does nothing', async () => {
    const task = await h().freshTask('a task whose request lapsed');
    okay(await w.ask(task.id));
    await h().world.db.admin.execute(
      `update public.task_delete_requests set requested_at = now() - interval '8 days',
              expires_at = now() - interval '1 day'
        where task_id = $1`,
      [task.id],
    );
    expect(await w.pendingOn(task.id), 'a lapsed request is not shown').toBeNull();
    for (const name of ['task.confirm_delete', 'task.decline_delete'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await w.answer(name, task.id);
      expect(refused.code, name).toBe('DELETE_REQUEST_NOT_PENDING');
    }
    expect(await w.readCode(task.id)).toBe('ok');
    okay(await w.ask(task.id), 'a new request after the old one lapsed');
  });

  it('a member without delete authority cannot confirm or keep', async () => {
    const task = await h().freshTask('a task a member tries to confirm');
    okay(await w.ask(task.id));
    for (const name of ['task.confirm_delete', 'task.decline_delete'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await w.answer(name, task.id, { caller: h().world.mia });
      expect(refused.code, name).toBe('SCOPE_NOT_GRANTED');
    }
    expect(await w.readCode(task.id)).toBe('ok');
    expect(await w.pendingOn(task.id)).not.toBeNull();
  });
});
