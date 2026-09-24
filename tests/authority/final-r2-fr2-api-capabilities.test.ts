// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, R2-AUTHORITY-56 and R2-AUTHORITY-57: what
// `session.capabilities` and `person.list` tell an external party (R4).
//
// An external party stands on a read share, and its only write is a
// client-audience comment (`commands/prepare.ts`, the R4 gate before any grant
// row). `reads/capabilities.ts` says such a party is shown its shares' pairs,
// so that a client never learns from a 403 what it was told it could do. These
// cases provision the rows a share never would, a record-scoped `write` or
// `comment` grant through `issueGrant` as `non-member-grants.test.ts` does,
// and ask both reads as the party itself over HTTP. A member holding the same
// `write` still sees it.

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

describe.skipIf(serverUrl === undefined)('R4 and the two reads that describe a business', () => {
  let world: World;

  const as = async (who: Caller, name: CommandName, body: Record<string, unknown>) =>
    await call(world.api, personPath('alpha', pathOf(name)), body, bearer(who.token));

  const makeTask = async (): Promise<string> => {
    const made = await as(world.ada, 'task.create', {
      operationId: randomUUID(),
      fields: { title: 'Shared with a client' },
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

  /** A shared outsider, plus whatever extra grants the case provisions. */
  const outsider = async (extra: readonly ('comment' | 'write')[]) => {
    const ext = await enrolExternal(world);
    const task = await makeTask();
    expect((await share(ext, task)).ok).toBe(true);
    for (const action of extra) {
      // oxlint-disable-next-line no-await-in-loop -- grants one after the other
      expect((await grant(ext, task, action)).ok).toBe(true);
    }
    return { ext, task };
  };

  beforeAll(async () => {
    world = await createWorld('r2_fr2_api_caps');
  });

  afterAll(async () => {
    await world?.close();
  });

  it('R2-AUTHORITY-57: a read share is shown its pair and nothing else', async () => {
    const { ext } = await outsider([]);
    const answer = await as(ext, 'session.capabilities', {});
    expect(answer.status).toBe(200);
    expect(answer.body).toStrictEqual({
      ok: true,
      personId: ext.personId,
      businessKey: 'alpha',
      grants: [{ collection: 'task', action: 'read' }],
    });
  });

  it('R2-AUTHORITY-57: person.list is refused to a party, and the refusal names no member', async () => {
    const { ext } = await outsider([]);
    const answer = await as(ext, 'person.list', {});
    expect({ status: answer.status, code: answer.code }).toStrictEqual({
      status: 403,
      code: 'SCOPE_NOT_GRANTED',
    });
    const members = await world.db.admin.execute<{ readonly id: string; readonly name: string }>(
      `select id, display_name as name from public.people
        where business_id = $1 and id <> $2`,
      [world.alpha, ext.personId],
    );
    expect(members.length).toBeGreaterThan(0);
    const text = JSON.stringify(answer.body);
    for (const member of members) {
      expect(text).not.toContain(member.id);
      expect(text).not.toContain(JSON.stringify(member.name));
    }
  });

  it('R2-AUTHORITY-56: a provisioned write beside a share is not shown, since every write refuses it', async () => {
    const { ext, task } = await outsider(['write']);
    const answer = await as(ext, 'session.capabilities', {});
    expect(answer.status).toBe(200);
    expect(answer.body['grants']).toStrictEqual([{ collection: 'task', action: 'read' }]);

    // What the list would have promised: the write it names is refused.
    const read = await as(world.ada, 'task.read', { recordId: task });
    const updated = await as(ext, 'task.update', {
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: Number((read.body['task'] as Record<string, unknown>)['revision']),
      fields: { title: 'changed from outside' },
    });
    expect({ status: updated.status, code: updated.code }).toStrictEqual({
      status: 403,
      code: 'SCOPE_NOT_GRANTED',
    });
  });

  it('R2-AUTHORITY-56: a provisioned comment beside a share is shown, since the client comment uses it', async () => {
    const { ext } = await outsider(['comment']);
    const answer = await as(ext, 'session.capabilities', {});
    expect(answer.body['grants']).toStrictEqual([
      { collection: 'task', action: 'comment' },
      { collection: 'task', action: 'read' },
    ]);
  });

  it('R2-AUTHORITY-56 control: a member holding task write still sees it', async () => {
    const answer = await as(world.ada, 'session.capabilities', {});
    expect(answer.status).toBe(200);
    expect(answer.body['grants']).toContainEqual({ collection: 'task', action: 'write' });
  });
});
