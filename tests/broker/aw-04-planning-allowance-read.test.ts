// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-04 planning allowance read` (U10; U7-SCORE's fourth fork): the drawer's
// allowance line reads `conversation.allowance`, through `executeRead`, on the
// planning world. It answers the business's planning cap, what is left of it
// across the business, and the caller's own conversation's settled spend and
// held amount. The cap and what is left are the business's, so the read is
// the team's (owner, administrator, member) holding `conversation:write`, as
// the tab row is; the conversation, when named, must be the caller's own, and
// anything else is NOT_FOUND byte for byte with a made-up id. No agent route.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { asAgent, asPerson, createTask, type Schedules } from '../runtime/schedules-harness.ts';
import { cq8World } from '../runtime/t2d-harness.ts';
import { noDatabase, s, world } from './broker-world.ts';
import { ask, ownerOf, p, plan, setCap, usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('aw04allow');
beforeAll(async () => {
  if (noDatabase) return;
  for (const on of [s, p.bravo]) {
    // eslint-disable-next-line no-await-in-loop
    await on.db.app.withBusiness(on.business, async (tx) => {
      await grantTo(tx, on.decider, 'write', undefined, false, 'conversation');
    });
  }
});

/** `conversation.allowance` as `member`, presenting in `on`'s business. */
const allowanceAs = async (
  on: Schedules,
  member: Member,
  body: Readonly<Record<string, unknown>> = {},
): Promise<unknown> =>
  await executeRead(on.db.app, on.business, member.presented, {
    read: 'conversation.allowance',
    ...body,
  });

/** A conversation `on`'s owner starts in the drawer: its id. */
async function started(on: Schedules): Promise<string> {
  const answer = await asPerson(on, {
    command: 'conversation.start',
    operationId: randomUUID(),
    body: 'plan the supplier follow-up',
  });
  const id = 'detail' in answer ? answer.detail?.['conversationId'] : undefined;
  if (typeof id !== 'string') throw new Error(`no conversation: ${JSON.stringify(answer)}`);
  return id;
}

it("AW-04 planning allowance read: the owner reads the cap, what is left across the business, and their own conversation's spent and held", async () => {
  await setCap(s, 2_000);
  const mine = await started(s);
  const other = await started(s);
  world.provider.mode('answer');
  const settled = await plan(s, ownerOf(s), ask(s, mine));
  const elsewhere = await plan(s, ownerOf(s), ask(s, other));
  world.provider.mode('malformed');
  expect(await plan(s, ownerOf(s), ask(s, mine))).toMatchObject({ code: 'LIABILITY_UNKNOWN' });
  if (!settled.ok || !elsewhere.ok) throw new Error('the priced replies did not settle');
  const spent = settled.actualMinor;
  expect(await allowanceAs(s, s.decider, { conversationId: mine })).toStrictEqual({
    ok: true,
    allowance: {
      set: true,
      currency: 'AUD',
      limitMinor: 2_000,
      // The business's: both conversations' settled actuals and the one hold.
      leftMinor: 2_000 - spent - elsewhere.actualMinor - 500,
      conversation: { spentMinor: spent, heldMinor: 500 },
    },
  });
}, 120_000);

it('AW-04 planning allowance read: the empty drawer, with no conversation yet, reads the default cap, all of it left, nothing spent', async () => {
  const fresh = {
    ok: true,
    allowance: {
      set: false,
      currency: 'AUD',
      limitMinor: 5_000,
      leftMinor: 5_000,
      conversation: { spentMinor: 0, heldMinor: 0 },
    },
  };
  expect(await allowanceAs(p.bravo, p.bravo.decider)).toStrictEqual(fresh);
  expect(await allowanceAs(p.bravo, p.bravo.decider, { conversationId: null })).toStrictEqual(
    fresh,
  );
  for (const conversationId of ['not-a-conversation', 7, '', ['x'], { id: 1 }]) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await allowanceAs(p.bravo, p.bravo.decider, { conversationId });
    expect(answer, JSON.stringify(conversationId)).toMatchObject({
      code: 'FIELD_VALUE_INVALID',
      names: ['conversationId'],
    });
  }
}, 60_000);

it('AW-04 planning allowance read isolation: another business, another client, another person under a live delegation', async () => {
  // Alpha's cap at a planted amount no crossing may see, and the owner's
  // conversation's spend on it.
  await s.db.admin.execute(
    `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
     values ($1, $2, 'planning', 13579, 'AUD')
     on conflict (business_id, key) do update set limit_minor = 13579`,
    [s.business, randomUUID()],
  );
  const mine = await started(s);
  world.provider.mode('answer');
  expect(await plan(s, ownerOf(s), ask(s, mine))).toMatchObject({ ok: true });
  const own = (await allowanceAs(s, s.decider, { conversationId: mine })) as {
    allowance: { leftMinor: number; conversation: { spentMinor: number } };
  };
  const left = String(own.allowance.leftMinor);
  const canary = new RegExp(`13579|135\\.79|${left}|${mine}|${s.business}`, 'u');
  expect(own.allowance.conversation.spentMinor).toBeGreaterThan(0);

  // 1. Another business: bravo's owner presenting in alpha, and in bravo naming alpha's.
  const inAlpha = await allowanceAs(s, p.bravo.decider, { conversationId: mine });
  const inBravo = await allowanceAs(p.bravo, p.bravo.decider, { conversationId: mine });
  const bravoOwn = await allowanceAs(p.bravo, p.bravo.decider);
  expect(inAlpha).toMatchObject({ code: 'AUTH_NO_MEMBERSHIP' });
  expect(inBravo).toMatchObject({ code: 'NOT_FOUND' });
  expect(bravoOwn).toMatchObject({ ok: true, allowance: { limitMinor: 5_000 } });

  // 2. Another client of alpha, shared one task: the cap and left are the team's.
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'share');
  });
  const task = await createTask(s, 'aw04allow client task');
  const client = await cq8World(s).client(s.business, s.decider, 'aw04al', task);
  const asClient = await allowanceAs(s, client);
  const asClientNaming = await allowanceAs(s, client, { conversationId: mine });
  for (const answer of [asClient, asClientNaming]) {
    expect(answer).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  }

  // 3. Another person: a colleague with their own drawer naming the owner's
  // conversation (one answer with a made-up id), a member with no drawer, and
  // the world's agent under its pickup's live delegation.
  const colleague = await enrol(s.db.app, s.business, 'aw04allow-colleague');
  const idle = await enrol(s.db.app, s.business, 'aw04allow-idle');
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, colleague, 'write', undefined, false, 'conversation');
  });
  const named = await allowanceAs(s, colleague, { conversationId: mine });
  const madeUp = await allowanceAs(s, colleague, { conversationId: randomUUID() });
  expect(named).toMatchObject({ code: 'NOT_FOUND' });
  expect(JSON.stringify(named)).toBe(JSON.stringify(madeUp));
  const asIdle = await allowanceAs(s, idle);
  expect(asIdle).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  const credential = String(p.work.picked['credential']);
  const asAgentBody = { command: 'conversation.allowance', operationId: randomUUID() };
  const agent = await asAgent(s, { ...asAgentBody, conversationId: mine }, credential);
  expect(agent).toMatchObject({ code: 'DELEGATION_EXCLUDES_OPERATION' });
  const [live] = await s.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.leases l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.id = $1 and d.revoked_at is null and d.settled_at is null and d.expires_at > now()`,
    [p.work.picked['leaseId']],
  );
  expect(live?.n).toBe('1');

  const crossed = [inAlpha, inBravo, bravoOwn, asClient, asClientNaming, named, asIdle, agent];
  expect(JSON.stringify(crossed)).not.toMatch(canary);
  expect(JSON.stringify(crossed)).not.toContain(credential);
  // The positive control: the owner's own read shows the planted cap.
  expect(own).toMatchObject({ ok: true, allowance: { set: true, limitMinor: 13_579 } });
}, 120_000);
