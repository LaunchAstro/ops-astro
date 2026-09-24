// SPDX-License-Identifier: AGPL-3.0-only
//
// Nathan's first-slice rulings on `task.comment`, over HTTP (OWNER-CARD
// section 6; events.log OWNER RULINGS 2).
//
// **Agent comments stay internal only.** A delegated agent writes a team note
// on its own task, and a client-audience comment from its credential is
// refused `AUDIENCE_NOT_PERMITTED` on the agent prefix and refused on the
// person prefix, with no comment written by either.
//
// **Commenting on a trashed task is refused for both entries.** `lockTask`
// holds a trashed row as well as a live one, because trash and restore need
// it, so both comment paths reached a trashed task and wrote to it. Each entry
// now answers a trashed task the way it answers a missing one: `NOT_FOUND`,
// the same status and bytes as an identifier nothing carries (API.md, the
// trashed-board rule), and nothing is written.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathOf } from '../../packages/core-records/src/commands/surface.ts';
import { DELEGATION_HEADER } from '../../packages/core-records/src/commands/surface.ts';
import { createHarness, type Harness } from './role-case-harness.ts';
import { bearer, call, personPath, serverUrl, type Answer } from './world.ts';

if (serverUrl === undefined) {
  console.warn('acceptance/comment-rulings: DATABASE_URL is unset, so nothing below ran.');
}

/** A refusal's status and body, which is everything a caller can compare. */
const bytesOf = (answer: Answer) => ({ status: answer.status, body: answer.body });

describe.skipIf(serverUrl === undefined)('task.comment: the owner rulings over HTTP', () => {
  let harness: Harness;
  let credential: string;
  let taskId: string;

  /** Comments on one task whose body is exactly `body`, whoever wrote them. */
  const commentsSaying = async (body: string): Promise<number> => {
    const rows = await harness.world.db.app.withBusiness(harness.world.alpha, (tx) =>
      tx.query<{ readonly n: string }>(
        `select count(*)::text as n from records
          where record_type_id = $1 and data ->> 'task' = $2 and data ->> 'body' = $3`,
        [harness.world.spineAlpha.taskCommentTypeId, taskId, body],
      ),
    );
    return Number(rows[0]?.n);
  };

  const revisionOf = async (recordId: string): Promise<number> => {
    const rows = await harness.world.db.app.withBusiness(harness.world.alpha, (tx) =>
      tx.query<{ readonly revision: string }>(
        `select revision::text as revision from records where id = $1`,
        [recordId],
      ),
    );
    // An identifier nothing carries is sent at revision 1, a valid revision.
    return Number(rows[0]?.revision ?? 1);
  };

  const asPersonOn = async (recordId: string, body: string): Promise<Answer> =>
    await harness.asPerson('task.comment', {
      recordId,
      expectedRevision: await revisionOf(recordId),
      body,
      audience: 'internal',
    });

  beforeAll(async () => {
    harness = await createHarness('comment_rulings');
    const { subject, decided } = await harness.approvedReservation();
    expect(decided.code, 'the decision a pickup needs').toBe('ok');
    const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
    const picked = await harness.asAgent('task.pickup', { reservationId });
    expect(picked.code, 'the pickup').toBe('ok');
    credential = String((picked.body['detail'] as Record<string, unknown>)['credential']);
    taskId = subject.id;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('an agent writes internal, and a client comment is refused on both prefixes', async () => {
    const internal = await harness.asAgent(
      'task.comment',
      { recordId: taskId, body: 'agent team note', audience: 'internal' },
      credential,
    );
    expect(internal.code).toBe('ok');

    const onAgent = await harness.asAgent(
      'task.comment',
      { recordId: taskId, body: 'agent to client, agent prefix', audience: 'client' },
      credential,
    );
    expect(onAgent.status).toBe(422);
    expect(onAgent.code).toBe('AUDIENCE_NOT_PERMITTED');

    // The same credential on the person prefix: an agent is not a person, so
    // it is refused before any audience is considered, and nothing is written.
    const onPerson = await call(
      harness.world.api,
      personPath('alpha', pathOf('task.comment')),
      {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: await revisionOf(taskId),
        body: 'agent to client, person prefix',
        audience: 'client',
      },
      { ...bearer(harness.world.agent.token), [DELEGATION_HEADER]: credential },
    );
    console.log(
      `agent client comment: agent prefix ${onAgent.status} ${onAgent.code}; person prefix ${onPerson.status} ${onPerson.code}`,
    );
    expect(onPerson.status).toBe(403);
    expect(onPerson.code).toBe('AUTH_NO_MEMBERSHIP');

    expect(await commentsSaying('agent team note')).toBe(1);
    expect(await commentsSaying('agent to client, agent prefix')).toBe(0);
    expect(await commentsSaying('agent to client, person prefix')).toBe(0);
  });

  it('a trashed task is NOT_FOUND to a comment on both entries, and nothing is written', async () => {
    const missing = await asPersonOn(randomUUID(), 'on nothing');
    expect(missing.code).toBe('NOT_FOUND');

    const trashed = await harness.asPerson('task.trash', {
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
    });
    expect(trashed.code, 'the trash').toBe('ok');

    const person = await asPersonOn(taskId, 'person on trash');
    const agent = await harness.asAgent(
      'task.comment',
      { recordId: taskId, body: 'agent on trash', audience: 'internal' },
      credential,
    );
    console.log(
      `trashed task comment: person ${person.status} ${person.code}; agent ${agent.status} ${agent.code}`,
    );

    expect(bytesOf(person)).toStrictEqual(bytesOf(missing));
    expect(bytesOf(agent)).toStrictEqual(bytesOf(missing));
    expect(await commentsSaying('person on trash')).toBe(0);
    expect(await commentsSaying('agent on trash')).toBe(0);
  });
});
