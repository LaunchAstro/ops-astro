// SPDX-License-Identifier: AGPL-3.0-only
//
// R4 holds whatever other grant rows a non-member carries (Sol 6 AUTHORITY-2).
//
// A person with no membership stands on a *read* share and nothing else
// (minimum contract 8.1 R4: "that task's shared fields and client-audience
// comments only"). `shareRecord` issues `read` alone for exactly that reason
// (`authority/shares.ts`). These cases provision the rows a share never would:
// record-scoped `comment` and `write` grants issued through `issueGrant`, the
// exported model path, since no public route issues them. Neither may carry a
// non-member to an internal comment or a task update, with or without a read
// share beside it, and a normal read share still answers the shared projection.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathOf, type CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import {
  bearer,
  call,
  createWorld,
  enrolExternal,
  personPath,
  serverUrl,
  type Caller,
  type World,
} from '../acceptance/world.ts';

const TITLE = 'Internal title the outsider must not change';
const CLIENT_NOTE = 'Hello, the draft is ready for your review.';

describe.skipIf(serverUrl === undefined)('R4 against provisioned comment and write grants', () => {
  let world: World;

  const as = async (who: Caller, name: CommandName, body: Record<string, unknown>) =>
    await call(world.api, personPath('alpha', pathOf(name)), body, bearer(who.token));

  const makeTask = async (): Promise<string> => {
    const made = await as(world.ada, 'task.create', {
      operationId: randomUUID(),
      fields: { title: TITLE },
    });
    expect(made.code).toBe('ok');
    return String(made.body['recordId']);
  };

  const grant = async (to: Caller, recordId: string, action: 'comment' | 'write') =>
    await world.db.app.withBusiness(world.alpha, (tx) =>
      issueGrant(tx, [{ kind: 'person', id: world.ada.personId as string }], {
        subject: { kind: 'person', id: to.personId as string },
        scope: { kind: 'record', id: recordId },
        collection: 'task',
        action,
        parentGrantId: null,
        grantedByActorId: world.ada.actorId as string,
      }),
    );

  const share = async (to: Caller, recordId: string) =>
    await world.db.app.withBusiness(world.alpha, (tx) =>
      shareRecord(
        tx,
        { personId: world.ada.personId as string, actorId: world.ada.actorId as string },
        { collection: 'task', recordId, personId: to.personId as string },
      ),
    );

  /** What a write would move: the task's revision and fields, and its comments. */
  const stateOf = async (recordId: string) =>
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      const task = await tx.query<Record<string, unknown>>(
        `select revision, data from records where id = $1`,
        [recordId],
      );
      const comments = await tx.query<Record<string, unknown>>(
        `select id from records where data->>'task' = $1`,
        [recordId],
      );
      return { task, comments: comments.length };
    });

  const auditOf = async (who: Caller) =>
    await world.db.app.withBusiness(world.alpha, (tx) =>
      tx.query<{ readonly command: string; readonly outcome: string }>(
        `select command, outcome from audit_events where actor_id = $1 order by seq`,
        [who.actorId],
      ),
    );

  const revisionOf = async (recordId: string): Promise<number> =>
    Number((await stateOf(recordId)).task[0]?.['revision']);

  const comment = async (who: Caller, recordId: string, audience: 'internal' | 'client') =>
    await as(who, 'task.comment', {
      operationId: randomUUID(),
      recordId,
      expectedRevision: await revisionOf(recordId),
      body: `an outsider wrote this (${audience})`,
      audience,
      ...(audience === 'client' ? { commentType: 'client' } : {}),
    });

  const update = async (who: Caller, recordId: string) =>
    await as(who, 'task.update', {
      operationId: randomUUID(),
      recordId,
      expectedRevision: await revisionOf(recordId),
      fields: { title: 'changed from outside' },
    });

  beforeAll(async () => {
    world = await createWorld('r4_provisioned');
  });

  afterAll(async () => {
    await world?.close();
  });

  it('comment and write grants alone are no standing: the login is refused and nothing moves', async () => {
    const ext = await enrolExternal(world);
    const task = await makeTask();
    for (const action of ['comment', 'write'] as const) {
      // eslint-disable-next-line no-await-in-loop -- two grants, one after the other
      expect((await grant(ext, task, action)).ok).toBe(true);
    }
    const before = await stateOf(task);

    const answers = {
      internal: await comment(ext, task, 'internal'),
      client: await comment(ext, task, 'client'),
      update: await update(ext, task),
      read: await as(ext, 'task.read', { recordId: task }),
    };
    console.log(
      `R4 grants alone: ${Object.entries(answers)
        .map(([name, answer]) => `${name} ${answer.status} ${answer.code}`)
        .join('; ')}`,
    );
    for (const [name, answer] of Object.entries(answers)) {
      expect({ name, status: answer.status, code: answer.code }).toStrictEqual({
        name,
        status: 403,
        code: 'AUTH_NO_MEMBERSHIP',
      });
    }
    expect(await stateOf(task)).toStrictEqual(before);
  });

  it('beside a read share, comment and write grants write no team note and no update', async () => {
    const ext = await enrolExternal(world);
    const task = await makeTask();
    const note = await as(world.ada, 'task.comment', {
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: await revisionOf(task),
      body: CLIENT_NOTE,
      audience: 'client',
      commentType: 'client',
    });
    expect(note.code).toBe('ok');
    expect((await share(ext, task)).ok).toBe(true);
    for (const action of ['comment', 'write'] as const) {
      // eslint-disable-next-line no-await-in-loop -- two grants, one after the other
      expect((await grant(ext, task, action)).ok).toBe(true);
    }
    const before = await stateOf(task);

    const internal = await comment(ext, task, 'internal');
    const updated = await update(ext, task);
    console.log(
      `R4 beside a share: internal ${internal.status} ${internal.code}; ` +
        `update ${updated.status} ${updated.code}`,
    );
    expect({ status: internal.status, code: internal.code }).toStrictEqual({
      status: 422,
      code: 'AUDIENCE_NOT_PERMITTED',
    });
    expect({ status: updated.status, code: updated.code }).toStrictEqual({
      status: 403,
      code: 'SCOPE_NOT_GRANTED',
    });
    expect(await stateOf(task)).toStrictEqual(before);
    // One refusal audit per attempt, and nothing applied.
    const refused = (await auditOf(ext)).filter((row) => row.command !== 'task.read');
    expect(refused).toStrictEqual([
      { command: 'task.comment', outcome: 'refused' },
      { command: 'task.update', outcome: 'refused' },
    ]);

    // The share itself still answers the shared projection.
    const read = await as(ext, 'task.read', { recordId: task });
    expect(read.status).toBe(200);
    expect(read.body['task']).toBeUndefined();
    const shared = read.body['sharedTask'] as Record<string, unknown>;
    expect(shared['comments']).toStrictEqual([
      expect.objectContaining({ audience: 'client', body: CLIENT_NOTE }),
    ]);
    expect(JSON.stringify(read.body)).not.toContain(TITLE);
  });

  it('the client audience is all R4 writes in, and only on the comment grant it holds', async () => {
    const ext = await enrolExternal(world);
    const task = await makeTask();
    expect((await share(ext, task)).ok).toBe(true);

    // A read share alone reaches no comment at all.
    const bare = await comment(ext, task, 'client');
    expect({ status: bare.status, code: bare.code }).toStrictEqual({
      status: 403,
      code: 'SCOPE_NOT_GRANTED',
    });

    expect((await grant(ext, task, 'comment')).ok).toBe(true);
    const client = await comment(ext, task, 'client');
    expect(client.code).toBe('ok');
    const read = await as(ext, 'task.read', { recordId: task });
    const shared = read.body['sharedTask'] as Record<string, unknown>;
    expect(shared['comments']).toStrictEqual([
      expect.objectContaining({ audience: 'client', body: 'an outsider wrote this (client)' }),
    ]);
  });
});
