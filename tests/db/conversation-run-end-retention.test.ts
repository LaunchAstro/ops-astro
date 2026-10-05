// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { purgeConversation, writeWrapUp } from '../../packages/core-commands/src/index.ts';
import { createWorld, type World, type Answer } from '../acceptance/world.ts';
import { asPerson, plannedTask, signed } from '../api/c54-fixture.ts';
import { setConversationWindow } from '../api/aw-03-fixture.ts';

// Deliberately no skip: a missing database is missing proof.
let w: World;
beforeAll(async () => {
  w = await createWorld('solow013');
  await w.db.app.withBusiness(w.alpha, async (tx) => await setConversationWindow(tx, 7));
}, 120_000);
afterAll(async () => await w?.close());

function conversationIdOf(answer: Answer): string {
  expect(answer.code).toBe('ok');
  const detail = answer.body['detail'];
  if (
    typeof detail !== 'object' ||
    detail === null ||
    !('conversationId' in detail) ||
    typeof detail.conversationId !== 'string'
  )
    throw new Error('no conversation id');
  return detail.conversationId;
}

async function openConversation(): Promise<string> {
  return conversationIdOf(
    await asPerson(w, signed(w.ada), 'conversation.start', {
      body: 'Sol OW-013 retention request',
    }),
  );
}

async function ageAndWrap(conversationId: string): Promise<void> {
  await w.db.admin.execute(
    `update public.conversations set created_at = created_at - interval '8 days',
       last_activity_at = last_activity_at - interval '8 days' where id = $1`,
    [conversationId],
  );
  expect(
    await w.db.app.withBusiness(
      w.alpha,
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: '4126931' }),
    ),
  ).toMatchObject({ ok: true, written: true });
}

const purge = async (conversationId: string) =>
  await w.db.app.withBusiness(
    w.alpha,
    async (tx) => await purgeConversation(tx, { conversationId, operationId: randomUUID() }),
  );

it('a run ending now keeps the conversation body for the retention window', async () => {
  const taskId = await plannedTask(w, signed(w.ada));
  const conversationId = await openConversation();
  const [run] = await w.db.admin.execute<{ id: string; lineage_id: string }>(
    'select id, lineage_id from public.planned_runs where business_id = $1 and task_id = $2',
    [w.alpha, taskId],
  );
  if (run === undefined) throw new Error('approved task has no run');
  // Seed the new migration's valid origin link; lifecycle operations remain the real ones.
  await w.db.admin.execute(
    'update public.planned_runs set origin_conversation_id = $2 where id = $1',
    [run.id, conversationId],
  );
  await ageAndWrap(conversationId);
  expect(await purge(conversationId)).toEqual({ ok: false, code: 'WORK_OPEN' });
  const cancelled = await asPerson(w, signed(w.ada), 'task.cancel', {
    recordId: taskId,
    lineageId: run.lineage_id,
    reason: 'Work ended now',
  });
  expect(cancelled.code).toBe('ok');
  const [ended] = await w.db.admin.execute<{ state: string; recent: boolean }>(
    `select r.state, l.terminal_at > clock_timestamp() - interval '1 minute' as recent
       from public.planned_runs r join public.proposal_lineages l on l.id = r.lineage_id
      where r.id = $1`,
    [run.id],
  );
  expect(ended).toMatchObject({ state: 'cancelled', recent: true });
  expect(await purge(conversationId)).toEqual({ ok: false, code: 'NOT_DUE' });
});

it('a run cancelled while its plan stays live has ended, so the body is held only for the window after', async () => {
  const taskId = await plannedTask(w, signed(w.ada));
  const conversationId = await openConversation();
  const [run] = await w.db.admin.execute<{ id: string; lineage_id: string }>(
    'select id, lineage_id from public.planned_runs where business_id = $1 and task_id = $2',
    [w.alpha, taskId],
  );
  if (run === undefined) throw new Error('approved task has no run');
  await w.db.admin.execute(
    'update public.planned_runs set origin_conversation_id = $2 where id = $1',
    [run.id, conversationId],
  );
  await ageAndWrap(conversationId);
  expect(await purge(conversationId)).toEqual({ ok: false, code: 'WORK_OPEN' });
  // The budget stop's own end (endAtBudgetStop, and the last ask spent in
  // stopAtSpentHold): the run is cancelled as the application role writes it,
  // and the plan's lineage is left live.
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await tx.query(
      `update public.planned_runs set state = 'cancelled' where business_id = $1 and id = $2`,
      [tx.businessId, run.id],
    );
  });
  const [lineage] = await w.db.admin.execute<{ terminal_at: Date | null }>(
    'select terminal_at from public.proposal_lineages where id = $1',
    [run.lineage_id],
  );
  expect(lineage).toEqual({ terminal_at: null });
  expect(await purge(conversationId)).toEqual({ ok: false, code: 'NOT_DUE' });
  // The end is the server's: a write that leaves the state alone keeps it.
  await w.db.admin.execute(
    `update public.planned_runs set ended_at = now() - interval '30 days' where id = $1`,
    [run.id],
  );
  expect(await purge(conversationId)).toEqual({ ok: false, code: 'NOT_DUE' });
});
