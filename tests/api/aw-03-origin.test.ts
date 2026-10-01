// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-03's origin setter and the wrap-up's tasks created, through the real
// boundary and a fresh Postgres. A task created from the drawer names its
// conversation; `task.create` records it as the creation audit event's
// origin (0199) once the conversation is found as the caller's own, in this
// business, with its body kept. The wrap-up then counts and points at the
// tasks whose creation names it. The audit rows, read as admin, are the oracle.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeWrapUp } from '../../packages/core-commands/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { createWorld, serverUrl, type Answer, type World } from '../acceptance/world.ts';
import {
  agentOnWork,
  asAgent,
  asPerson,
  billingHolder,
  externalClient,
  signed,
  type Signed,
} from './c54-fixture.ts';

// eslint-disable-next-line max-lines-per-function -- one world, each origin case on it
describe.skipIf(serverUrl === undefined)('AW-03 a task created from its conversation', () => {
  let world: World;
  let ada: Signed;
  let conversationId: string;

  const create = async (who: Signed, title: string, origin?: unknown): Promise<Answer> =>
    await asPerson(world, who, 'task.create', {
      fields: { title },
      ...(origin === undefined ? {} : { conversationId: origin }),
    });

  const originOf = async (taskId: string): Promise<string | null | undefined> =>
    (
      await world.db.admin.execute<{ readonly origin: string | null }>(
        `select origin_conversation_id::text as origin from public.audit_events
          where subject_record_id = $1 and command = 'task.create' and outcome = 'applied'`,
        [taskId],
      )
    )[0]?.origin;

  const tasksTitled = async (title: string): Promise<number> =>
    Number(
      (
        await world.db.admin.execute<{ readonly n: string }>(
          `select count(*)::text as n from public.records where data->>'title' = $1`,
          [title],
        )
      )[0]?.n,
    );

  beforeAll(async () => {
    world = await createWorld('aw03origin');
    ada = signed(world.ada);
    const opened = await asPerson(world, ada, 'conversation.start', {
      body: 'Please set up the launch tasks.',
      title: 'Launch',
    });
    conversationId = String((opened.body['detail'] as Record<string, unknown>)['conversationId']);
  }, 120_000);

  afterAll(async () => await world?.close());

  it('AW-03 origin set: a task created from the owner’s conversation names it on its creation event; one created without names none', async () => {
    const from = await create(ada, 'a task from the drawer', conversationId);
    expect(from.code).toBe('ok');
    expect(await originOf(String(from.body['recordId']))).toBe(conversationId);
    const plain = await create(ada, 'a task from the board');
    expect(plain.code).toBe('ok');
    expect(await originOf(String(plain.body['recordId']))).toBeNull();
  });

  it('AW-03 origin isolation: another person’s, another business’s or a made-up conversation is refused as not found, and no task is made', async () => {
    // Another person in the business, who may create tasks, names ada's conversation.
    const colleague = await billingHolder(world, world.alpha, 'alpha', 'aw03-colleague');
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, colleague, 'write');
    });
    const theirs = await create(colleague, 'a colleague names it', conversationId);
    const madeUp = await create(colleague, 'a made-up origin', randomUUID());
    expect(theirs.code).toBe('NOT_FOUND');
    expect(theirs.body).toStrictEqual(madeUp.body);
    // Another business: bravo's writer names alpha's conversation.
    const bravo = await billingHolder(world, world.bravo, 'bravo', 'aw03-bravo');
    await world.db.app.withBusiness(world.bravo, async (tx) => {
      await grantTo(tx, bravo, 'write');
    });
    const foreign = await create(bravo, 'bravo names it', conversationId);
    expect(foreign.code).toBe('NOT_FOUND');
    // Another client, on a task shared with them: a share creates nothing (R4).
    const task = await create(ada, 'a task shared with a client');
    const client = await externalClient(world, ada, String(task.body['recordId']));
    const shared = await create(client, 'a client names it', conversationId);
    expect(shared.status).toBe(403);
    // Another person under a live delegation: the agent reaches no task.create.
    const agent = await agentOnWork(world, ada);
    const delegated = await asAgent(
      world,
      'task.create',
      { fields: { title: 'the agent names it' }, conversationId },
      agent.credential,
    );
    expect(delegated.status).toBe(403);
    for (const title of ['a colleague names it', 'a made-up origin', 'bravo names it']) {
      // eslint-disable-next-line no-await-in-loop -- one title at a time
      expect(await tasksTitled(title), title).toBe(0);
    }
    for (const answer of [theirs, foreign, shared, delegated]) {
      expect(JSON.stringify(answer.body)).not.toContain('Launch');
    }
  });

  it('AW-03 tasks created: the wrap-up counts the tasks whose creation names the conversation and points at each', async () => {
    await world.db.admin.execute(
      `update public.conversations
          set last_activity_at = last_activity_at - interval '8 days',
              created_at = created_at - interval '8 days'
        where id = $1`,
      [conversationId],
    );
    const written = await world.db.app.withBusiness(
      world.alpha,
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: 'aw03origin' }),
    );
    expect(written).toMatchObject({ ok: true, written: true });
    const [row] = await world.db.admin.execute<{
      readonly items: readonly Record<string, unknown>[];
    }>(
      `select items from public.conversation_wrap_ups where conversation_id = $1 order by version desc limit 1`,
      [conversationId],
    );
    const item = row?.items.find((each) => each['key'] === 'tasks_created');
    expect(item?.['fact']).toBe('1 task created');
    const pointers = item?.['pointers'] as readonly Record<string, unknown>[];
    expect(pointers.map((pointer) => pointer['kind'])).toStrictEqual(['task']);
    expect(String(pointers[0]?.['address'])).toMatch(/^\/task\/[0-9a-f-]{36}$/u);
  });
});
