// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11 spend isolation: a child spends only on its own parent's lease. Three
// crossings, statuses checked and a stored canary absent from every refusal:
// another business's lease; another task's lease in the same business,
// shared with another client; another agent's lease under its own live
// delegation (another person's work in the helper's reach).

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { codeOf } from '../runtime/schedules-harness.ts';
import { callOn, callsOn, childSpend, noDatabase, useSpendWorld, w } from './aw-11-spend-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useSpendWorld('aw11spendi');

it('AW-11 spend isolation: another business', async () => {
  const canary = `aw11-spend-alpha-${randomUUID()}`;
  const alpha = await childSpend(w.s, w.helper, 2_000, canary);
  const bravo = await childSpend(w.bravo, w.bravoHelper, 2_000);
  // Bravo's child on alpha's lease, presented in bravo: no such lease there.
  const crossed = await callOn(w.bravo, alpha.work, w.bravoHelper.presented, bravo.childCredential);
  expect(codeOf(crossed)).not.toBe('applied');
  expect(JSON.stringify(crossed)).not.toContain(canary);
  expect(JSON.stringify(crossed)).not.toContain(alpha.work.taskId);
  expect(await callsOn(w.s, alpha.work)).toStrictEqual([]);
  // Control: bravo's child spends on bravo's own lease.
  expect(
    codeOf(await callOn(w.bravo, bravo.work, w.bravoHelper.presented, bravo.childCredential)),
  ).toBe('applied');
});

it('AW-11 spend isolation: another client in the same business', async () => {
  const canary = `aw11-spend-client-two-${randomUUID()}`;
  const one = await childSpend(w.s, w.helper, 2_000);
  const two = await childSpend(w.s, w.helper, 2_000, canary);
  // One's child on two's lease: two's task is outside its purpose.
  const crossed = await callOn(w.s, two.work, w.helper.presented, one.childCredential);
  expect(codeOf(crossed)).toBe('DELEGATION_OUT_OF_PURPOSE');
  expect(JSON.stringify(crossed)).not.toContain(canary);
  expect(JSON.stringify(crossed)).not.toContain(two.work.taskId);
  expect(await callsOn(w.s, two.work)).toStrictEqual([]);
});

it('AW-11 spend isolation: another person, an agent under a live delegation of its own', async () => {
  const canary = `aw11-spend-person-${randomUUID()}`;
  const mine = await childSpend(w.s, w.helper, 2_000, canary);
  // The parent's own agent, presenting the child's credential, and the helper
  // presenting the parent's: neither is the other's authority.
  const borrowed = await callOn(w.s, mine.work, w.s.agent, mine.childCredential);
  expect(codeOf(borrowed)).toBe('DELEGATION_NOT_LIVE');
  const lent = await callOn(w.s, mine.work, w.helper.presented, mine.parentCredential);
  expect(codeOf(lent)).toBe('DELEGATION_NOT_LIVE');
  for (const body of [borrowed, lent]) expect(JSON.stringify(body)).not.toContain(canary);
  expect(await callsOn(w.s, mine.work)).toStrictEqual([]);
});
