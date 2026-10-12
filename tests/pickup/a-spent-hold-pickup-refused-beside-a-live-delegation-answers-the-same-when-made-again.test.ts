// SPDX-License-Identifier: AGPL-3.0-only
//
// A pickup at a spent hold refused beside the agent's live delegation for the purpose, made again:
// with its operation id after the answer, after its commit was cut before or after it reached the
// database, and after the delegation settled. The intent is answered once, and no ask is raised
// for it however often it arrives.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { s, useBrokerWorld } from '../broker/broker-world.ts';
import { codeOf, cutProxy, racer, settle, type CutPoint } from '../runtime/schedules-harness.ts';
import { asksOn, delegationBeside, pickupOf, spentWhole } from '../runtime/resume-sizing-world.ts';

useBrokerWorld('spentholdagain');

const LATER = (): Date => new Date(Date.now() + 600_000);

const settleDelegation = async (id: string): Promise<void> => {
  await s.db.admin.execute('update public.delegations set settled_at = now() where id = $1', [id]);
};

it.skipIf(serverUrl === undefined)(
  'the refused stop made again with its operation id answers the same refusal, before and after the delegation settles',
  async () => {
    const work = await spentWhole('made again');
    const live = await delegationBeside(work, LATER());
    const operationId = randomUUID();
    expect(codeOf(await pickupOf(work, { operationId }))).toBe('DELEGATION_ALREADY_LIVE');
    expect(codeOf(await pickupOf(work, { operationId }))).toBe('DELEGATION_ALREADY_LIVE');
    await settleDelegation(live);
    expect(codeOf(await pickupOf(work, { operationId }))).toBe('DELEGATION_ALREADY_LIVE');
    expect(await asksOn(work)).toEqual([]);
    // A new intent, once nothing holds the purpose, is the one that asks.
    expect(codeOf(await pickupOf(work))).toBe('BUDGET_UNAVAILABLE');
    expect(await asksOn(work)).toHaveLength(1);
  },
);

it.skipIf(serverUrl === undefined).each<CutPoint>(['before-commit', 'after-commit'])(
  'a refused stop whose commit is cut %s, made again with its operation id, raises no ask',
  async (point) => {
    const work = await spentWhole(`cut ${point}`);
    await delegationBeside(work, LATER());
    const operationId = randomUUID();
    const proxy = await cutProxy(s.db.appUrl, point);
    const cut = racer(s, proxy.url);
    try {
      const [interrupted] = await settle([pickupOf(work, { database: cut, operationId })]);
      expect(proxy.cut(), `the relay never reached its ${point} point`).toBe(true);
      expect(interrupted?.status).toBe('rejected');
    } finally {
      // A client whose socket the relay killed may never finish ending: give it a second.
      await Promise.race([cut.close().catch(() => null), delay(1_000)]);
      await proxy.close();
    }
    expect(await asksOn(work)).toEqual([]);
    expect(codeOf(await pickupOf(work, { operationId }))).toBe('DELEGATION_ALREADY_LIVE');
    expect(await asksOn(work)).toEqual([]);
  },
);
