// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation's wrap-up cost item reads the conversation's planning
// ledger: a priced reply settled against its envelope is counted with its
// spend, and a conversation with no priced reply says none was recorded.

import { expect, it as vitestIt } from 'vitest';
import { itemsOf } from '../../packages/core-commands/src/commands/conversation-contents.ts';
import type { Schedules } from '../runtime/schedules-harness.ts';
import { noDatabase, s, world } from './broker-world.ts';
import { ask, ownerOf, plan, setCap, usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('wrapcost');

const costOf = async (on: Schedules, conversationId: string) => {
  const at = new Date();
  const items = await on.db.app.withBusiness(
    on.business,
    async (tx) =>
      await itemsOf(
        tx,
        conversationId,
        { created_at: at, last_activity_at: at, scope_record_id: null },
        [],
      ),
  );
  return items.find((item) => item.key === 'cost')?.fact;
};

it("a conversation's wrap-up counts its settled priced replies and their spend", async () => {
  await setCap(s, 100_000);
  const request = await ask(s);
  world.provider.mode('answer');
  const first = await plan(s, ownerOf(s), request);
  const second = await plan(s, ownerOf(s), request);
  if (!first.ok || !second.ok) throw new Error('a priced reply was refused');
  const spent = first.actualMinor + second.actualMinor;
  expect(spent).toBeGreaterThan(0);
  const amount = `${String(Math.trunc(spent / 100))}.${String(spent % 100).padStart(2, '0')}`;
  expect(await costOf(s, request.conversation.id)).toBe(
    `2 priced model calls, AUD ${amount} spent`,
  );
});

it("a conversation's wrap-up with no priced reply says none was recorded", async () => {
  const request = await ask(s);
  expect(await costOf(s, request.conversation.id)).toBe('No priced model call recorded');
});
