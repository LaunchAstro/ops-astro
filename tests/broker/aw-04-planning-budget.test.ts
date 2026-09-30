// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-04 planning budget` (U10, ORCH42 (a)): a priced planning reply from the
// owner's own conversation holds its priced maximum on that conversation's
// planning envelope, under the business's planning cap (`budget_caps` key
// `planning`), read under the cap's row lock. No cap set: no planning spend.
// The allowance line (the cap, and what is left) reads before the first
// message; the planning spend (settled plus held) reads beside the plan. A
// failed reply stays held as unknown liability against the envelope. The
// isolation case crosses another business, another person of the business
// (a client of it, holding a share) and an agent under a live delegation.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { writeAuditEvent } from '../../packages/core-commands/src/commands/audit.ts';
import {
  callModelForPlanning,
  readPlanningAllowance,
  type Broker,
  type ConversationCallRequest,
  type ModelCaller,
  type ModelCallResult,
  type PlanningAllowance,
} from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  createTask,
  liveWork,
  racer,
  seedSchedules,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { cq8World } from '../runtime/t2d-harness.ts';
import {
  LOCAL,
  PLANTED_PROMPT,
  callCount,
  digestOf,
  noDatabase,
  s,
  useBrokerWorld,
  withRoutes,
  world,
} from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw04plan');

let bravo: Schedules;
let work: Work;

beforeAll(async () => {
  if (noDatabase) return;
  bravo = await seedSchedules(s.db, 'aw04plan-bravo', 1_000_000);
  work = await liveWork(s, `aw04plan-${randomUUID()}`, 2_000);
}, 180_000);

const ownerOf = (on: Schedules): ModelCaller => ({
  actorId: on.decider.actorId,
  delegationId: null,
  attendedByPersonId: on.decider.personId,
});

const ask = (on: Schedules, id: string = randomUUID()): ConversationCallRequest => ({
  conversation: { id, businessId: on.business, ownerPersonId: on.decider.personId },
  operation: 'model.replay_compose',
  fields: [{ name: 'message', source: 'outside', value: PLANTED_PROMPT }],
});

/** The local route (planning replies keep AW-03's egress rule), audited as `on`'s agent. */
const local = (on: Schedules): Broker => ({
  ...withRoutes([LOCAL]),
  audit: async (tx, note) => {
    await writeAuditEvent(tx, {
      actorId: on.agentActorId,
      command: note.action,
      outcome: note.outcome,
      refusalCode: note.refusalCode,
      payloadDigest: digestOf(note.detail),
      attempted: note.outcome === 'refused' ? note.detail : null,
    });
  },
});

const plan = async (
  on: Schedules,
  caller: ModelCaller,
  request: ConversationCallRequest,
  database: Database = on.db.app,
): Promise<ModelCallResult> =>
  await callModelForPlanning(database, on.business, caller, request, local(on));

async function setCap(on: Schedules, limitMinor: number): Promise<void> {
  await on.db.admin.execute(
    `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
     values ($1, $2, 'planning', $3, 'AUD')`,
    [on.business, randomUUID(), limitMinor],
  );
}

const allowance = async (
  on: Schedules,
  personId: string,
  conversationId: string,
): Promise<PlanningAllowance> =>
  await on.db.app.withBusiness(
    on.business,
    async (tx) => await readPlanningAllowance(tx, personId, conversationId),
  );

const rowsFor = async (on: Schedules, id: string): Promise<readonly Record<string, unknown>[]> =>
  await on.db.admin.execute(`select * from public.model_calls where conversation_id = $1`, [id]);

it('AW-04 planning budget: with no planning cap set, a planning reply is refused and nothing is written or sent', async () => {
  const request = ask(s);
  const before = await callCount();
  const sent = world.provider.seen.length;
  const result = await plan(s, ownerOf(s), request);
  expect(result).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE', callId: null });
  expect(await callCount()).toBe(before);
  expect(world.provider.seen.length).toBe(sent);
  expect(await allowance(s, s.decider.personId, request.conversation.id)).toStrictEqual({
    set: false,
    currency: null,
    limitMinor: 0,
    leftMinor: 0,
    conversation: { spentMinor: 0, heldMinor: 0 },
  });
});

it('AW-04 planning budget: the allowance line reads before the first message, then a priced reply holds its maximum and settles at its price on the envelope', async () => {
  await setCap(s, 1_200);
  const request = ask(s);
  expect(await allowance(s, s.decider.personId, request.conversation.id)).toStrictEqual({
    set: true,
    currency: 'AUD',
    limitMinor: 1_200,
    leftMinor: 1_200,
    conversation: { spentMinor: 0, heldMinor: 0 },
  });
  world.provider.mode('answer');
  const result = await plan(s, ownerOf(s), request);
  expect(result).toMatchObject({ ok: true, reservedMinor: 500 });
  const actual = result.ok ? result.actualMinor : -1;
  expect(actual).toBeGreaterThan(0);
  const [row, ...more] = await rowsFor(s, request.conversation.id);
  expect(more).toStrictEqual([]);
  expect(row).toMatchObject({ state: 'settled', reserved_minor: '500', run_id: null });
  expect(row?.['planning_envelope_id']).toEqual(expect.any(String));
  expect(await allowance(s, s.decider.personId, request.conversation.id)).toMatchObject({
    leftMinor: 1_200 - actual,
    conversation: { spentMinor: actual, heldMinor: 0 },
  });
});

it('AW-04 planning budget: a failed reply stays held at its maximum against the envelope, and the next reply that no longer fits is refused', async () => {
  const request = ask(s);
  const before = await allowance(s, s.decider.personId, request.conversation.id);
  world.provider.mode('costly');
  expect(await plan(s, ownerOf(s), request)).toMatchObject({
    ok: false,
    code: 'LIABILITY_UNKNOWN',
    heldMinor: 500,
  });
  world.provider.mode('answer');
  const after = await allowance(s, s.decider.personId, request.conversation.id);
  expect(after).toMatchObject({
    leftMinor: before.leftMinor - 500,
    conversation: { spentMinor: 0, heldMinor: 500 },
  });
  // What is left is under one reply's maximum now: refused, nothing written.
  const calls = await callCount();
  expect(await plan(s, ownerOf(s), request)).toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
  expect(await callCount()).toBe(calls);
});

it('AW-04 planning budget: two replies racing for the last of the allowance, on two connections at once: one holds, one is refused', async () => {
  await setCap(bravo, 800);
  world.provider.mode('answer');
  const second = racer(bravo);
  try {
    const [one, two] = await Promise.all([
      plan(bravo, ownerOf(bravo), ask(bravo)),
      plan(bravo, ownerOf(bravo), ask(bravo), second),
    ]);
    const codes = [one, two].map((result) => (result.ok ? 'held' : result.code)).sort();
    expect(codes).toStrictEqual(['BUDGET_UNAVAILABLE', 'held']);
  } finally {
    await second.close();
  }
});

it('AW-04 planning budget isolation: another business, another client, another person under a live delegation', async () => {
  const mine = ask(s);
  world.provider.mode('answer');
  expect(await plan(s, ownerOf(s), mine)).toMatchObject({ ok: true });
  const id = mine.conversation.id;
  const calls = await callCount();
  const foreign = new RegExp(`${id}|${s.business}|${PLANTED_PROMPT}`, 'u');

  // 1. Another business: bravo's owner, in bravo, naming alpha's conversation.
  const crossed = await plan(bravo, ownerOf(bravo), {
    ...mine,
    conversation: { ...mine.conversation, ownerPersonId: bravo.decider.personId },
  });
  expect(crossed).toMatchObject({ ok: false, code: 'AUTHORITY_LOST', callId: null });
  const bravoRead = await allowance(bravo, bravo.decider.personId, id);
  expect(bravoRead.conversation).toStrictEqual({ spentMinor: 0, heldMinor: 0 });
  expect(JSON.stringify([crossed, bravoRead])).not.toMatch(foreign);

  // 2. Another client of the business, shared one task: not the conversation's owner.
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'share');
  });
  const task = await createTask(s, 'aw04plan client task');
  const client: Member = await cq8World(s).client(s.business, s.decider, 'aw04pc', task);
  const asClient = await plan(s, { ...ownerOf(s), attendedByPersonId: client.personId }, mine);
  expect(asClient).toMatchObject({ ok: false, code: 'AUTHORITY_LOST', callId: null });
  expect((await allowance(s, client.personId, id)).conversation).toStrictEqual({
    spentMinor: 0,
    heldMinor: 0,
  });

  // 3. Another person, and an agent acting under a live delegation for the owner.
  const other = await enrol(s.db.app, s.business, 'aw04plan-other');
  const asOther = await plan(s, { ...ownerOf(s), attendedByPersonId: other.personId }, mine);
  const asAgent = await plan(
    s,
    {
      actorId: s.agentActorId,
      delegationId: String(work.picked['delegationId'] ?? randomUUID()),
      attendedByPersonId: s.decider.personId,
    },
    mine,
  );
  for (const refused of [asOther, asAgent]) {
    expect(refused).toMatchObject({ ok: false, code: 'AUTHORITY_LOST', callId: null });
  }
  expect((await allowance(s, other.personId, id)).conversation).toStrictEqual({
    spentMinor: 0,
    heldMinor: 0,
  });
  expect(await callCount()).toBe(calls);
  expect(JSON.stringify([asClient, asOther, asAgent])).not.toMatch(foreign);
  // The owner's own read still shows the spend the crossings could not see.
  expect((await allowance(s, s.decider.personId, id)).conversation.spentMinor).toBeGreaterThan(0);
}, 120_000);
