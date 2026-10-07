// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-04 planning allowance read` for a member (owner ruling Q4, 1 Oct 2026:
// "conversation:write members see the cap and what remains, as settings.read
// does"). A member holding `conversation:write` across the business reads the
// business's planning cap and what is left of it, the same cap `settings.read`
// shows; a member without it is refused before any figure; and the spend and
// hold a member reads are their own conversation's, never a colleague's.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand, executeRead } from '../../packages/core-commands/src/index.ts';
import type { ModelCaller } from '../../packages/core-custody/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { noDatabase, s, world } from './broker-world.ts';
import { allowance, ask, ownerOf, plan, setCap, usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('aw04allowm');

/** The member the ruling names: role `member`, `conversation:write` across the business. */
const m = {} as { writer: Member; plain: Member; settingsOnly: Member; ownerTalk: string };

const read = async (who: Member, body: Readonly<Record<string, unknown>>): Promise<unknown> =>
  await executeRead(s.db.app, s.business, who.presented, body as never);

/** `who` starts a conversation in the drawer: its id. */
async function started(who: Member): Promise<string> {
  const answer = await executeCommand(s.db.app, s.business, who.presented, 'api', {
    command: 'conversation.start',
    operationId: randomUUID(),
    body: 'plan the supplier follow-up',
  } as never);
  const id = 'detail' in answer ? answer.detail?.['conversationId'] : undefined;
  if (typeof id !== 'string') throw new Error(`no conversation: ${JSON.stringify(answer)}`);
  return id;
}

const callerOf = (who: Member): ModelCaller => ({
  actorId: who.actorId,
  delegationId: null,
  attendedByPersonId: who.personId,
});

beforeAll(async () => {
  if (noDatabase) return;
  m.writer = await enrol(s.db.app, s.business, 'aw04allowm-writer');
  m.plain = await enrol(s.db.app, s.business, 'aw04allowm-plain');
  m.settingsOnly = await enrol(s.db.app, s.business, 'aw04allowm-settings');
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'write', undefined, false, 'conversation');
    await grantTo(tx, s.decider, 'read', undefined, false, 'settings');
    await grantTo(tx, m.writer, 'write', undefined, false, 'conversation');
    await grantTo(tx, m.settingsOnly, 'read', undefined, false, 'settings');
  });
  await setCap(s, 24_680);
  // The owner's spend is the business's too: what is left counts it.
  m.ownerTalk = await started(s.decider);
  world.provider.mode('answer');
  const settled = await plan(s, ownerOf(s), await ask(s, m.ownerTalk));
  if (!settled.ok) throw new Error(`the owner's reply did not settle: ${JSON.stringify(settled)}`);
}, 120_000);

it('AW-04 planning allowance read: a member holding conversation:write reads the business cap and what is left, the same cap the settings read shows', async () => {
  const theirs = (await read(m.writer, { read: 'conversation.allowance' })) as {
    allowance: Record<string, unknown>;
  };
  const owners = (await read(s.decider, { read: 'conversation.allowance' })) as typeof theirs;
  const settings = (await read(s.decider, { read: 'settings.read' })) as {
    planningCap: { limitMinor: number; currency: string; set: boolean };
  };
  expect(settings.planningCap).toStrictEqual({ limitMinor: 24_680, currency: 'AUD', set: true });
  const { limitMinor, currency, set } = settings.planningCap;
  expect(theirs).toStrictEqual({
    ok: true,
    allowance: {
      set,
      currency,
      limitMinor,
      leftMinor: owners.allowance['leftMinor'],
      conversation: { spentMinor: 0, heldMinor: 0 },
    },
  });
  expect(theirs.allowance['leftMinor']).toBeLessThan(limitMinor);
}, 60_000);

it('AW-04 planning allowance read: a member without conversation:write is refused SCOPE_NOT_GRANTED before any figure', async () => {
  const answers = [
    await read(m.plain, { read: 'conversation.allowance' }),
    await read(m.plain, { read: 'conversation.allowance', conversationId: m.ownerTalk }),
    // Reading the settings is not the drawer's key: the cap there, refused here.
    await read(m.settingsOnly, { read: 'conversation.allowance' }),
  ];
  for (const answer of answers) expect(answer).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  expect(JSON.stringify(answers)).not.toMatch(/24680|246\.80|leftMinor|limitMinor|allowance"/u);
  // The positive control: the same settings reader sees the cap in the settings.
  expect(await read(m.settingsOnly, { read: 'settings.read' })).toMatchObject({
    planningCap: { limitMinor: 24_680 },
  });
}, 60_000);

it("AW-04 planning allowance read: a member's own conversation's spent and held, never a colleague's", async () => {
  const own = await started(m.writer);
  world.provider.mode('answer');
  const base = await ask(s, own);
  const mine = await plan(s, callerOf(m.writer), {
    ...base,
    conversation: { ...base.conversation, ownerPersonId: m.writer.personId },
  });
  if (!mine.ok) throw new Error(`the member's reply did not settle: ${JSON.stringify(mine)}`);
  // The owner's conversation carries a hold the member's does not: a reply gone unknown.
  world.provider.mode('malformed');
  expect(await plan(s, ownerOf(s), await ask(s, m.ownerTalk))).toMatchObject({
    code: 'LIABILITY_UNKNOWN',
  });
  const ownerSpent = (await allowance(s, s.decider.personId, m.ownerTalk)).conversation;
  expect(ownerSpent).toMatchObject({ heldMinor: 500 });
  expect(ownerSpent.spentMinor).toBeGreaterThan(0);
  expect(
    await read(m.writer, { read: 'conversation.allowance', conversationId: own }),
  ).toMatchObject({
    ok: true,
    allowance: { conversation: { spentMinor: mine.actualMinor, heldMinor: 0 } },
  });
  // The colleague's (the owner's) conversation, named: NOT_FOUND, as a made-up id.
  const named = await read(m.writer, {
    read: 'conversation.allowance',
    conversationId: m.ownerTalk,
  });
  const madeUp = await read(m.writer, {
    read: 'conversation.allowance',
    conversationId: randomUUID(),
  });
  expect(named).toMatchObject({ code: 'NOT_FOUND' });
  expect(JSON.stringify(named)).toBe(JSON.stringify(madeUp));
  // Inside the broker's query too: the member's person on the owner's conversation reads none.
  expect((await allowance(s, m.writer.personId, m.ownerTalk)).conversation).toStrictEqual({
    spentMinor: 0,
    heldMinor: 0,
  });
  // And the owner's own read shows the owner's spend, never the member's.
  expect(
    await read(s.decider, { read: 'conversation.allowance', conversationId: m.ownerTalk }),
  ).toMatchObject({ ok: true, allowance: { conversation: ownerSpent } });
}, 120_000);
