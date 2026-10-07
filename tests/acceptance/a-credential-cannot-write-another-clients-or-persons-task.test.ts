// SPDX-License-Identifier: AGPL-3.0-only
//
// Audit proof for PR #948, finding FIX1.2 (criterion 2): an agent credential's
// task.update, task.assign and task.comment, issued while its person held the
// whole business and used after their grants narrowed to their own record,
// cannot cross to another client's task or to another person's task. The
// own-task control is allowed; the crossed tasks keep their title, assignee,
// comments and inbox exactly as they were.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { pathOf } from '../../packages/core-wire/src/index.ts';
import type { CommandName } from '../../packages/core-wire/src/index.ts';
import { enrolCaller, MEMBER_ACTIONS } from './cast.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import {
  agentPath,
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type Caller,
  type World,
} from './world.ts';

const CANARY = `audit-948-canary-${randomUUID()}`;
let world: World;

const asPerson = (who: Caller, name: CommandName, body: Record<string, unknown>) =>
  call(world.api, personPath('alpha', pathOf(name)), body, bearer(who.token));

async function revisionOf(id: string): Promise<number> {
  const [row] = await world.db.admin.execute<{ revision: string }>(
    'select revision::text as revision from public.records where id = $1',
    [id],
  );
  return Number(row?.revision);
}

async function newClient(): Promise<string> {
  const made = await world.db.admin.execute<{ readonly id: string }>(
    `insert into public.clients (business_id, id, name, created_by_actor_id)
     values ($1, gen_random_uuid(), $3, $2) returning id`,
    [world.alpha, world.ada.actorId, `Audit client ${randomUUID()}`],
  );
  return String(made[0]?.id);
}

/** A task Ada makes and puts on `client` through the product's own commands. */
async function taskOn(client: string, title: string): Promise<string> {
  const made = await asPerson(world.ada, 'task.create', {
    operationId: randomUUID(),
    fields: { title },
  });
  if (made.code !== 'ok') throw new Error(`task.create refused ${made.code}`);
  const id = String(made.body['recordId']);
  const set = await asPerson(world.ada, 'task.set_party', {
    operationId: randomUUID(),
    recordId: id,
    expectedRevision: made.body['revision'],
    fields: { client },
  });
  if (set.code !== 'ok') throw new Error(`task.set_party refused ${set.code}`);
  return id;
}

/** A member holding the task keys and credential:write over the whole business. */
const enrolIssuer = (name: string) =>
  enrolCaller(world.db, world.alpha, 'alpha', name, {
    membership: true,
    actions: MEMBER_ACTIONS,
    collections: ['task'],
    extraPairs: [['credential', 'write']],
  });

/** Revoke the person's business-wide task grants and grant them `records` only. */
async function narrowTo(who: Caller, records: readonly string[]): Promise<void> {
  const wide = await world.db.admin.execute<{ id: string }>(
    `select id from public.grants
      where subject_kind = 'person' and subject_id = $1 and collection = 'task'
        and scope_kind = 'business' and revoked_at is null`,
    [who.personId],
  );
  const member = who as unknown as Member;
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    for (const { id } of wide) {
      // eslint-disable-next-line no-await-in-loop -- one revoke at a time
      if ((await revokeGrant(tx, id)) === null) throw new Error('revoke refused');
    }
    for (const recordId of records) {
      for (const action of MEMBER_ACTIONS) {
        // eslint-disable-next-line no-await-in-loop -- one grant at a time
        await grantTo(tx, member, action, { kind: 'record', id: recordId });
      }
    }
  });
}

async function stateOf(id: string) {
  const [task] = await world.db.admin.execute<{
    title: string;
    assignee: string | null;
    revision: string;
  }>(
    `select data ->> 'title' as title, data ->> 'assignee' as assignee,
            revision::text as revision
       from public.records where id = $1`,
    [id],
  );
  const comments = await world.db.admin.execute<{ audience: string }>(
    "select data ->> 'audience' as audience from public.records where data ->> 'task' = $1",
    [id],
  );
  const inbox = await world.db.admin.execute<{ n: string }>(
    'select count(*)::text as n from public.inbox_items where subject_record_id = $1',
    [id],
  );
  return { task, comments: [...comments], inbox: inbox[0]?.n };
}

describe.skipIf(serverUrl === undefined)(
  'API-2 credential writes across clients and people',
  () => {
    beforeAll(async () => {
      world = await createWorld('audit_948_fix1_2');
    }, 180_000);
    afterAll(async () => {
      await world?.close();
    });

    // eslint-disable-next-line max-lines-per-function, max-statements -- one scenario, end to end
    it('a credential cannot write another client’s or person’s task', async () => {
      const clientX = await newClient();
      const clientY = await newClient();
      const own = await taskOn(clientX, 'Pia own task on client X');
      const otherClient = await taskOn(clientY, `Client Y ${CANARY}`);
      const otherPerson = await taskOn(clientX, `Quin on client X ${CANARY}`);

      const pia = await enrolIssuer('pia');
      const quin = await enrolIssuer('quin');
      const issued = await asPerson(pia, 'credential.issue', {
        operationId: randomUUID(),
        scope: ['write', 'assign', 'comment'].map((action) => ({ collection: 'task', action })),
        purpose: 'audit 948 boundary',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const credential = (issued.body['detail'] as { readonly credential?: unknown } | undefined)
        ?.credential;
      if (typeof credential !== 'string') throw new Error(`credential missing: ${issued.text}`);

      await narrowTo(pia, [own]);
      await narrowTo(quin, [otherClient, otherPerson]);

      const before = {
        otherClient: await stateOf(otherClient),
        otherPerson: await stateOf(otherPerson),
      };
      const asAgent = async (name: CommandName, recordId: string, body: Record<string, unknown>) =>
        await call(
          world.api,
          agentPath('alpha', pathOf(name)),
          {
            operationId: randomUUID(),
            recordId,
            expectedRevision: await revisionOf(recordId),
            ...body,
          },
          bearer(credential),
        );
      const attempts = async (recordId: string) => {
        const answers = [
          await asAgent('task.update', recordId, { fields: { title: 'Written by the agent' } }),
          await asAgent('task.assign', recordId, { fields: { assignee: world.mia.personId } }),
          await asAgent('task.comment', recordId, { body: 'crossed note', audience: 'internal' }),
        ];
        return answers.map((answer) => ({
          status: answer.status,
          code: answer.code,
          leaks: answer.text.includes(recordId) || answer.text.includes(CANARY),
        }));
      };

      const crossings = {
        clientToClient: await attempts(otherClient),
        personToPerson: await attempts(otherPerson),
      };
      const control = await attempts(own);
      const refusal = { status: 403, code: 'SCOPE_NOT_GRANTED', leaks: false };

      expect({
        crossings,
        after: { otherClient: await stateOf(otherClient), otherPerson: await stateOf(otherPerson) },
      }).toStrictEqual({
        crossings: {
          clientToClient: [refusal, refusal, refusal],
          personToPerson: [refusal, refusal, refusal],
        },
        after: before,
      });
      expect(control.map((answer) => answer.code)).toStrictEqual(['ok', 'ok', 'ok']);
      const mine = await stateOf(own);
      expect({
        task: mine.task?.title,
        assignee: mine.task?.assignee,
        comments: mine.comments,
      }).toStrictEqual({
        task: 'Written by the agent',
        assignee: world.mia.personId,
        comments: [{ audience: 'internal' }],
      });
    });
  },
);
