// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  purgeConversation,
  sweepConversations,
  writeWrapUp,
} from '../../packages/core-commands/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import {
  conversationWorld,
  setConversationWindow,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createControls, PROPOSAL, type Controls } from './controls-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import type { Answer } from './fixture.ts';

// Conversation retention holds for created work, decided gates and an unreadable window.
let w: ConversationWorld;
let c: Controls;
let model: LocalModel;
let second: Database;
beforeAll(async () => {
  c = await createControls('solow031');
  w = await conversationWorld(c);
  model = await localModel();
  second = connect(w.fixture.db.appUrl);
  await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    await setConversationWindow(tx, 7);
    await grantTo(tx, w.owner, 'share');
  });
}, 180_000);
afterAll(async () => {
  await model?.close();
  await second?.close();
  await w?.drop();
});
const wrap = async (conversationId: string) =>
  await w.fixture.db.app.withBusiness(
    w.fixture.business,
    async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: '4126931' }),
  );
const purge = async (conversationId: string) =>
  await w.fixture.db.app.withBusiness(
    w.fixture.business,
    async (tx) => await purgeConversation(tx, { conversationId, operationId: randomUUID() }),
  );
const task = async (title: string, conversationId?: string) => {
  const answer = await w.as(w.owner, 'task.create', {
    fields: { title },
    ...(conversationId === undefined ? {} : { conversationId }),
  });
  expect(answer.status).toBe(200);
  return String(answer.body['recordId']);
};
const messages = async (conversationId: string) =>
  await w.count(
    'select count(*) as n from public.conversation_messages where conversation_id = $1',
    [conversationId],
  );

/** Names the conversation as the origin of the run planned with the proposal. */
const linkRun = async (proposal: Record<string, unknown>, conversationId: string) => {
  const linked = await w.fixture.db.admin.execute<{ state: string }>(
    `update public.planned_runs set origin_conversation_id = $2
      where version_id = $1 returning state`,
    [proposal['versionId'], conversationId],
  );
  expect(linked).toEqual([{ state: 'planned' }]);
};

it('an open task created by a conversation holds its body and is left open in the wrap-up', async () => {
  const conversationId = await started(w, w.owner, { body: 'Create the follow-up work' });
  const taskId = await task('still open created work', conversationId);
  await w.age(conversationId, 8);
  expect(await wrap(conversationId)).toMatchObject({ ok: true, written: true });
  const [row] = await w.fixture.db.admin.execute<{ items: unknown; left_open: unknown }>(
    'select items, left_open from public.conversation_wrap_ups where conversation_id = $1',
    [conversationId],
  );
  expect(JSON.stringify(row?.items)).toContain(taskId);
  const outcome = await purge(conversationId);
  expect({
    outcome,
    messages: await messages(conversationId),
    leftOpen: row?.left_open,
  }).toMatchObject({
    outcome: { ok: false, code: 'WORK_OPEN' },
    messages: 1,
    leftOpen: [{ kind: 'task', id: taskId }],
  });
});

it('the sweep reports an unreadable window even with no old body to purge', async () => {
  // Exclude the other cases' candidates with the clock, then make the
  // configured window invalid using the real settings writer.
  await w.fixture.db.admin.execute(
    'update public.conversations set last_activity_at = now() where business_id = $1 and body_purged_at is null',
    [w.fixture.business],
  );
  await w.fixture.db.app.withBusiness(
    w.fixture.business,
    async (tx) => await setConversationWindow(tx, 3),
  );
  try {
    const report = await sweepConversations(w.fixture.db.app, {
      businessId: w.fixture.business,
      codeRevision: '4126931',
    });
    expect(report).toMatchObject({ windowUnreadable: true, purged: [] });
  } finally {
    await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await setConversationWindow(tx, 7),
    );
  }
});

it('a gate decided today restarts the conversation retention window', async () => {
  const created = await c.createTask('gate terminal time');
  const proposal = await c.propose(created.id, created.revision, 'gate_terminal_time');
  await c.approve(proposal);
  const conversationId = await started(w, w.owner, { body: 'The gate is conversation work' });
  // Supply only the origin reference. The gate, decision, timestamps and
  // resulting terminal state are produced by the shipped commands.
  await w.fixture.db.admin.execute(
    'update public.gates set origin_conversation_id = $2 where id = $1',
    [proposal['gateId'], conversationId],
  );
  const [gate] = await w.fixture.db.admin.execute<{ state: string; recent: boolean }>(
    "select state, decided_at > now() - interval '1 minute' as recent from public.gates where id = $1",
    [proposal['gateId']],
  );
  expect(gate).toEqual({ state: 'approved', recent: true });
  await w.age(conversationId, 8);
  expect(await wrap(conversationId)).toMatchObject({ ok: true, written: true });
  expect({
    outcome: await purge(conversationId),
    messages: await messages(conversationId),
  }).toMatchObject({
    outcome: { ok: false, code: 'NOT_DUE' },
    messages: 1,
  });
});

it('a gate left pending past its expiry, and the run behind it, have ended at its expiry and no longer hold the body', async () => {
  const created = await c.createTask('gate past expiry');
  const proposal = await c.propose(created.id, created.revision, 'gate_past_expiry');
  const conversationId = await started(w, w.owner, {
    body: 'The undecided gate is conversation work',
  });
  await w.fixture.db.admin.execute(
    "update public.gates set origin_conversation_id = $2, expires_at = now() - interval '8 days' where id = $1",
    [proposal['gateId'], conversationId],
  );
  await linkRun(proposal, conversationId);
  const [gate] = await w.fixture.db.admin.execute<{ state: string }>(
    'select state from public.gates where id = $1',
    [proposal['gateId']],
  );
  expect(gate).toEqual({ state: 'pending' });
  await w.age(conversationId, 8);
  expect(await wrap(conversationId)).toMatchObject({ ok: true, written: true });
  expect({
    outcome: await purge(conversationId),
    messages: await messages(conversationId),
  }).toMatchObject({
    outcome: { ok: true },
    messages: 0,
  });
});

it('a run whose plan is rejected before it starts has ended at the rejection', async () => {
  const created = await c.createTask('run behind a rejected plan');
  const proposal = await c.propose(created.id, created.revision, 'run_plan_rejected');
  const conversationId = await started(w, w.owner, {
    body: 'The planned run is conversation work',
  });
  await linkRun(proposal, conversationId);
  await w.age(conversationId, 8);
  expect(await wrap(conversationId)).toMatchObject({ ok: true, written: true });
  expect(await purge(conversationId)).toEqual({ ok: false, code: 'WORK_OPEN' });
  const rejected = await c.asPerson('task.decide', {
    gateId: proposal['gateId'],
    versionId: proposal['versionId'],
    decision: 'reject',
    note: 'not this plan',
  });
  expect(rejected.status).toBe(200);
  expect({
    outcome: await purge(conversationId),
    messages: await messages(conversationId),
  }).toMatchObject({ outcome: { ok: false, code: 'NOT_DUE' }, messages: 1 });
});

/** Waits until a backend in this database waits on a lock. */
async function someoneWaits(): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling the server
    const n = await w.count(
      `select count(*) as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
      [],
    );
    if (n >= 1) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(25);
  }
  throw new Error('no backend ever waited on the conversation lock');
}

it('a task created from a conversation racing its purge waits on the conversation lock and is refused; no task names a purged conversation', async () => {
  const conversationId = await started(w, w.owner, { body: 'Purge me while a task is made' });
  await w.age(conversationId, 8);
  expect(await wrap(conversationId)).toMatchObject({ ok: true, written: true });
  let racer: Promise<Answer> | undefined;
  const purged = await second.withBusiness(w.fixture.business, async (tx) => {
    const outcome = await purgeConversation(tx, { conversationId, operationId: randomUUID() });
    racer = w.as(w.owner, 'task.create', { fields: { title: 'Raced work' }, conversationId });
    await someoneWaits();
    return outcome;
  });
  if (racer === undefined) throw new Error('the create never started');
  const created = await racer;
  expect(purged).toMatchObject({ ok: true, replayed: false, messagesPurged: 1 });
  expect(created.body['code']).toBe('NOT_FOUND');
  expect(
    await w.count(
      `select count(*) as n from public.audit_events
        where origin_conversation_id = $1 and command = 'task.create'`,
      [conversationId],
    ),
  ).toBe(0);
});

it('a run picked up and then superseded by a new version has ended at the supersede', async () => {
  const created = await c.createTask('run behind a superseded version');
  const proposal = await c.propose(created.id, created.revision, 'run_superseded');
  await c.pickup(await c.approve(proposal));
  const conversationId = await started(w, w.owner, {
    body: 'The claimed run is conversation work',
  });
  const [run] = await w.fixture.db.admin.execute<{ state: string }>(
    `update public.planned_runs set origin_conversation_id = $2
      where version_id = $1 returning state`,
    [proposal['versionId'], conversationId],
  );
  expect(run).toEqual({ state: 'claimed' });
  await w.age(conversationId, 8);
  expect(await wrap(conversationId)).toMatchObject({ ok: true, written: true });
  expect(await purge(conversationId)).toEqual({ ok: false, code: 'WORK_OPEN' });
  const [record] = await w.fixture.db.admin.execute<{ revision: string }>(
    'select revision::text as revision from public.records where id = $1',
    [created.id],
  );
  const revised = await c.asPerson('task.propose', {
    recordId: created.id,
    expectedRevision: Number(record?.revision),
    ...PROPOSAL,
    purpose: 'run_superseded',
    lineageId: proposal['lineageId'],
  });
  expect(revised.status).toBe(200);
  expect(await purge(conversationId)).toEqual({ ok: false, code: 'NOT_DUE' });
});
