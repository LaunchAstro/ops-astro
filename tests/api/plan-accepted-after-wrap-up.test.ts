// SPDX-License-Identifier: AGPL-3.0-only
//
// PRV-oa-1111 finding 1, in conversation-retention-work's world: a plan
// accepted in a conversation after its quiet wrap-up was written is activity
// in that conversation. The wrap-up written before it no longer covers it, so
// it cannot release the body, and the next wrap-up, at the next quiet, lists
// the accepted run and gate, with the planned run left open and holding the
// body.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { purgeConversation, writeWrapUp } from '../../packages/core-commands/src/index.ts';
import {
  conversationWorld,
  setConversationWindow,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { createControls, detailOf, type Controls } from './controls-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { acceptBody, useInstructionRoot } from '../runtime/aw-04-world.ts';
import { changed, fingerprint, undeclared } from '../operations/s0-5-effect-diff.ts';

let w: ConversationWorld;
let c: Controls;
beforeAll(async () => {
  c = await createControls('prv1111_wrap');
  w = await conversationWorld(c);
  await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    await setConversationWindow(tx, 7);
    await grantTo(tx, w.owner, 'share');
  });
}, 180_000);
useInstructionRoot();
afterAll(async () => {
  await w?.drop();
});
const wrap = async (conversationId: string) =>
  await w.fixture.db.app.withBusiness(
    w.fixture.business,
    async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: 'prv1111' }),
  );
const purge = async (conversationId: string) =>
  await w.fixture.db.app.withBusiness(
    w.fixture.business,
    async (tx) => await purgeConversation(tx, { conversationId, operationId: randomUUID() }),
  );
const messages = async (conversationId: string) =>
  await w.count(
    'select count(*) as n from public.conversation_messages where conversation_id = $1',
    [conversationId],
  );

interface ServedWrapUp {
  readonly version: number;
  readonly items: readonly { key: string; pointers: readonly { id: string }[] }[];
  readonly leftOpen: readonly { kind: string; id: string; state?: string }[];
}
const pointerIds = (wrapUp: ServedWrapUp, key: string): readonly string[] =>
  wrapUp.items.find((item) => item.key === key)?.pointers.map((pointer) => pointer.id) ?? [];

it('a plan accepted after the quiet wrap-up reaches the next wrap-up, and the stale one never lets the body go', async () => {
  const conversationId = await started(w, w.owner, { body: 'Plan it after the wrap-up' });
  const created = await c.createTask('existing task, planned after the wrap-up');
  const proposal = await c.propose(created.id, created.revision, 'accepted_after_wrap_up');
  await w.age(conversationId, 8);
  expect(await wrap(conversationId)).toEqual({ ok: true, version: 1, written: true });
  const accepted = await c.asPerson(
    'task.accept_plan',
    acceptBody({ taskId: created.id, proposal }, { conversationId }),
    w.owner,
  );
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const runId = String(detailOf(accepted)['runId']);
  const gateId = String(proposal['gateId']);
  // The accept is activity in the conversation: version 1 no longer covers
  // it, so it cannot release the body, and the next wrap-up comes at quiet.
  expect(await purge(conversationId)).toEqual({ ok: false, code: 'WRAP_UP_ABSENT' });
  expect(await wrap(conversationId)).toEqual({ ok: false, reason: 'not_quiet' });
  await w.age(conversationId, 8);
  expect(await wrap(conversationId)).toEqual({ ok: true, version: 2, written: true });
  const read = await w.as(w.owner, 'conversation.read', { conversationId });
  expect(read.status).toBe(200);
  const wrapUp = read.body['wrapUp'] as ServedWrapUp;
  expect({
    version: wrapUp.version,
    runs: pointerIds(wrapUp, 'runs_started'),
    gates: pointerIds(wrapUp, 'gates_raised'),
    leftOpen: wrapUp.leftOpen,
  }).toEqual({
    version: 2,
    runs: [runId],
    gates: [gateId],
    leftOpen: [expect.objectContaining({ kind: 'run', id: runId, state: 'planned' })],
  });
  expect({
    outcome: await purge(conversationId),
    messages: await messages(conversationId),
  }).toMatchObject({ outcome: { ok: false, code: 'WORK_OPEN' }, messages: 1 });
});

it('an accept in a conversation declares the conversation it moves among its writes', async () => {
  const conversationId = await started(w, w.owner, {
    body: 'Plan it, and say what the accept writes',
  });
  const created = await c.createTask('existing task, its accept effect-proved');
  const proposal = await c.propose(created.id, created.revision, 'accept_effects_declared');
  const before = await fingerprint(w.fixture.db.admin);
  const accepted = await c.asPerson(
    'task.accept_plan',
    acceptBody({ taskId: created.id, proposal }, { conversationId }),
    w.owner,
  );
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const written = changed(before, await fingerprint(w.fixture.db.admin));
  expect(written).toContain('conversations');
  expect(undeclared('task.accept_plan', written)).toEqual([]);
});
