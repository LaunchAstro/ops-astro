// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-03: the conversation outlives its body, through the real boundary and a
// fresh Postgres.
//
// `address_outlives_the_body` is the ticket's invariant, written first: a
// conversation held with the agent, its address pasted into a task, the body
// purged by the product's own purge after its window, and the address read
// again through the API and the command line, answering the wrap-up with
// pointers that open. `AW-03 purge real` is every purge case on a real purge:
// the wrap-up at quiet from records with item 8, open work holding the body,
// no purge without a wrap-up, the wrap-up table out of any purge's reach, one
// audit event however often the same purge is asked for, and a resumed
// conversation's second wrap-up version beside the first.
//
// The clock is the only thing moved by hand (`age`): a real window of seven
// days, the floor, and a conversation whose activity is eight days old.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  purgeConversation,
  writeWrapUp,
  type PurgeOutcome,
  type WrapUpOutcome,
} from '../../packages/core-commands/src/index.ts';
import { writeBusinessSetting } from '../../packages/core-records/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  CODE_REVISION,
  conversationWorld,
  detail,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Pointer {
  readonly kind: string;
  readonly id: string;
  readonly address: string;
}
interface WrapUp {
  readonly version: number;
  readonly writtenBy: { readonly operation: string; readonly codeRevision: string };
  readonly request: { readonly quotation: string };
  readonly items: readonly { readonly key: string; readonly pointers: readonly Pointer[] }[];
  readonly leftOpen: readonly Pointer[];
  readonly leftOpenText: string;
}
interface Address {
  readonly conversation: { readonly id: string; readonly bodyPurgedAt: string | null };
  readonly messages: readonly { readonly body: string }[] | null;
  readonly wrapUp: WrapUp | null;
  readonly wrapUpHistory: readonly { readonly version: number }[];
}

// eslint-disable-next-line max-lines-per-function -- one world, every purge case on it
describe.skipIf(serverUrl === undefined)('AW-03 the conversation outlives its body', () => {
  let w: ConversationWorld;

  const inBusiness = async <T>(work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await w.fixture.db.app.withBusiness(w.fixture.business, work);
  const wrapUp = async (conversationId: string): Promise<WrapUpOutcome> =>
    await inBusiness(
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: CODE_REVISION }),
    );
  const purge = async (conversationId: string, operationId = randomUUID()): Promise<PurgeOutcome> =>
    await inBusiness(async (tx) => await purgeConversation(tx, { conversationId, operationId }));
  const read = async (conversationId: string): Promise<Address> => {
    const answer = await w.as(w.owner, 'conversation.read', { conversationId });
    expect(answer.status).toBe(200);
    return answer.body as unknown as Address;
  };

  /** A task, a conversation scoped to it, and the task complete, so nothing is left open. */
  async function heldAndSettled(
    subject: string,
  ): Promise<{ taskId: string; conversationId: string }> {
    const created = await w.as(w.owner, 'task.create', { fields: { title: `${subject} task` } });
    expect(created.status).toBe(200);
    const taskId = (created.body as { recordId: string }).recordId;
    const conversationId = await started(w, w.owner, {
      scope: { kind: 'task', id: taskId },
      subject,
      body: `Please draft the ${subject} reply.`,
    });
    const task = await w.as(w.owner, 'task.read', { recordId: taskId });
    const revision = (task.body['task'] as { revision: number }).revision;
    const done = await w.as(w.owner, 'task.complete', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: revision,
    });
    expect(done.status).toBe(200);
    return { taskId, conversationId };
  }

  beforeAll(async () => {
    w = await conversationWorld('aw_03_address');
    await inBusiness(async (tx) => {
      await writeBusinessSetting(tx, { key: 'conversation_window_days', value: 7 });
    });
  }, 120_000);

  afterAll(async () => await w?.drop());

  it('address_outlives_the_body: after a real purge the address answers the wrap-up with working pointers, through the API and the command line', async () => {
    const { taskId, conversationId } = await heldAndSettled('address');
    const address = detail(
      await w.as(w.owner, 'conversation.message', {
        conversationId,
        body: 'And cite the supplier terms.',
      }),
    )['address'];
    expect(address).toBe(`/agent/${conversationId}`);
    await w.age(conversationId, 8);
    await w.fixture.db.admin.execute(
      `update public.records
          set data = jsonb_set(data, '{completed_at}', to_jsonb((now() - interval '8 days')::text))
        where id = $1`,
      [taskId],
    );

    expect(await wrapUp(conversationId)).toMatchObject({ ok: true, version: 1, written: true });
    expect(await purge(conversationId)).toMatchObject({
      ok: true,
      replayed: false,
      messagesPurged: 2,
    });
    expect(
      await w.count(
        `select count(*) as n from public.conversation_messages where conversation_id = $1`,
        [conversationId],
      ),
    ).toBe(0);

    const viaApi = await read(conversationId);
    expect(viaApi.conversation.bodyPurgedAt).not.toBeNull();
    expect(viaApi.messages).toBeNull();
    expect(viaApi.wrapUp?.version).toBe(1);
    expect(viaApi.wrapUp?.request.quotation).toBe('Please draft the address reply.');
    expect(viaApi.wrapUp?.leftOpenText).toBe('nothing left open');
    const pointers = viaApi.wrapUp?.items.flatMap((item) => item.pointers) ?? [];
    const toTask = pointers.find((pointer) => pointer.kind === 'task' && pointer.id === taskId);
    expect(toTask?.address).toBe(`/task/${taskId}`);
    // A pointer that works: it opens the task it names.
    expect((await w.as(w.owner, 'task.read', { recordId: taskId })).status).toBe(200);

    const viaCli = await w.cli(w.owner, 'conversation.read', { conversationId });
    expect(viaCli.status).toBe(200);
    expect((viaCli.body as Address).wrapUp).toEqual(viaApi.wrapUp);
    expect((viaCli.body as Address).messages).toBeNull();

    const teammate = await w.cli(w.colleague, 'conversation.read', { conversationId });
    expect(teammate.status).toBe(403);
    expect((teammate.body as { code: string }).code).toBe('SCOPE_NOT_GRANTED');
  });

  it('AW-03 purge real: opening the drawer writes nothing; identity is minted at the first message', async () => {
    const before = await w.count(`select count(*) as n from public.conversations`, []);
    const refused = await w.as(w.owner, 'conversation.start', { subject: 'empty', body: '' });
    expect(refused.status).toBe(422);
    expect(await w.count(`select count(*) as n from public.conversations`, [])).toBe(before);
    await started(w, w.owner, { subject: 'first', body: 'The first message.' });
    expect(await w.count(`select count(*) as n from public.conversations`, [])).toBe(before + 1);
  });

  it('AW-03 purge real: item 8 names the open work, and open work holds the body', async () => {
    const created = await w.as(w.owner, 'task.create', { fields: { title: 'open work' } });
    const taskId = (created.body as { recordId: string }).recordId;
    const conversationId = await started(w, w.owner, {
      scope: { kind: 'task', id: taskId },
      body: 'Keep this open.',
    });
    await w.age(conversationId, 8);
    expect(await wrapUp(conversationId)).toMatchObject({ ok: true, version: 1 });
    const open = (await read(conversationId)).wrapUp;
    expect(open?.leftOpen.map((pointer) => pointer.id)).toEqual([taskId]);
    expect(open?.leftOpenText).not.toBe('nothing left open');
    expect(await purge(conversationId)).toEqual({ ok: false, code: 'WORK_OPEN' });
    expect((await read(conversationId)).messages).toHaveLength(1);
  });

  it('AW-03 purge real: no wrap-up, no purge (WRAP_UP_ABSENT), and a conversation still in use is not quiet', async () => {
    const conversationId = await started(w, w.owner, { body: 'Never wrapped.' });
    expect(await wrapUp(conversationId)).toEqual({ ok: false, reason: 'not_quiet' });
    await w.age(conversationId, 8);
    expect(await purge(conversationId)).toEqual({ ok: false, code: 'WRAP_UP_ABSENT' });
    expect((await read(conversationId)).messages).toHaveLength(1);
  });

  it('AW-03 purge real: the same purge twice is one purge and one audit event; the wrap-up table is out of reach', async () => {
    const { taskId, conversationId } = await heldAndSettled('twice');
    await w.age(conversationId, 8);
    await w.fixture.db.admin.execute(
      `update public.records
          set data = jsonb_set(data, '{completed_at}', to_jsonb((now() - interval '8 days')::text))
        where id = $1`,
      [taskId],
    );
    await wrapUp(conversationId);
    const operationId = randomUUID();
    expect(await purge(conversationId, operationId)).toMatchObject({ ok: true, replayed: false });
    expect(await purge(conversationId, operationId)).toMatchObject({ ok: true, replayed: true });
    expect(
      await w.count(
        `select count(*) as n from public.audit_events where command = 'conversation.purge' and operation_id = $1`,
        [operationId],
      ),
    ).toBe(1);
    await expect(
      inBusiness(
        async (tx) =>
          await tx.query(`delete from conversation_wrap_ups where conversation_id = $1`, [
            conversationId,
          ]),
      ),
    ).rejects.toThrow();
    expect((await read(conversationId)).wrapUp?.version).toBe(1);
  });

  it('AW-03 purge real: a conversation resumed after its wrap-up gets version 2 at the next quiet, and version 1 is kept', async () => {
    const conversationId = await started(w, w.owner, { body: 'The first round.' });
    await w.age(conversationId, 2);
    expect(await wrapUp(conversationId)).toMatchObject({ ok: true, version: 1, written: true });
    expect(await wrapUp(conversationId)).toMatchObject({ ok: true, version: 1, written: false });
    expect(
      detail(await w.as(w.owner, 'conversation.message', { conversationId, body: 'Back again.' })),
    ).toBeDefined();
    await w.age(conversationId, 2);
    expect(await wrapUp(conversationId)).toMatchObject({ ok: true, version: 2, written: true });
    const both = await read(conversationId);
    expect(both.wrapUp?.version).toBe(2);
    expect(both.wrapUpHistory.map((entry) => entry.version)).toEqual([2, 1]);
    expect(both.wrapUp?.writtenBy).toEqual({
      operation: 'conversation.wrap_up',
      codeRevision: CODE_REVISION,
    });
  });

  it('AW-03 purge real: a window under seven days or longer than the work window stops the purge, and says so', async () => {
    const conversationId = await started(w, w.owner, { body: 'Window bounds.' });
    await w.age(conversationId, 8);
    await wrapUp(conversationId);
    for (const days of [3, 45]) {
      // eslint-disable-next-line no-await-in-loop -- one setting at a time
      await inBusiness(async (tx) => {
        await writeBusinessSetting(tx, { key: 'conversation_window_days', value: days });
      });
      // eslint-disable-next-line no-await-in-loop
      expect(await purge(conversationId)).toEqual({ ok: false, code: 'WINDOW_UNREADABLE' });
    }
    await inBusiness(async (tx) => {
      await writeBusinessSetting(tx, { key: 'conversation_window_days', value: 7 });
    });
    expect((await read(conversationId)).messages).toHaveLength(1);
  });
});
