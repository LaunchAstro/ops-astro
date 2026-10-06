// SPDX-License-Identifier: AGPL-3.0-only
//
// R7 isolation: two businesses in one database, each with a conversation due
// and a body planted in it. Alpha's window cannot be read, so its pass fails;
// Bravo's purges. Alpha's sweep never wraps or purges Bravo's conversation,
// and Alpha's failures never name Bravo, its conversation or either body.
//
// Red before `apps/api/conversation-sweeper.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepRound } from '../../apps/api/conversation-sweeper.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { raisedFailures, REVISION, sweeperWorld, type SweeperWorld } from './r7-sweeper-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('R7 conversation sweeper isolation', () => {
  let s: SweeperWorld;

  beforeAll(async () => {
    s = await sweeperWorld('r7_sweeper_isolation');
  }, 120_000);

  afterAll(async () => {
    await s?.w.drop();
  });

  it("R7 isolation: one business's sweep and its failures never touch or name another's conversations", async () => {
    const alphaCanary = `CANARY-ALPHA-${randomUUID()}`;
    const bravoCanary = `CANARY-BRAVO-${randomUUID()}`;
    const alphaDue = await s.dueInAlpha(`${alphaCanary} Alpha's body`);
    const bravoDue = await s.dueInBravo(`${bravoCanary} Bravo's body`);
    await s.window(s.alpha, 3);
    const { failures, raise } = raisedFailures();
    const over = (businesses: readonly string[]): (() => Promise<void>) =>
      sweepRound(s.db, {
        businesses: async () => await Promise.resolve(businesses),
        codeRevision: REVISION,
        raise,
      });

    const alphaOnly = over([s.alpha]);
    await alphaOnly();
    await alphaOnly();
    expect(await s.wrapUps(alphaDue)).toBe(1);
    expect(await s.messages(alphaDue)).toBe(1);
    expect(await s.wrapUps(bravoDue), "Alpha's sweep wrapped Bravo's conversation").toBe(0);
    expect(await s.messages(bravoDue)).toBe(1);

    const both = over([s.alpha, s.bravo.id]);
    await both();
    await both();
    expect(await s.messages(bravoDue)).toBe(0);
    expect(await s.messages(alphaDue)).toBe(1);

    expect(failures).toEqual([
      { businessId: s.alpha, cause: 'window_unreadable', conversationIds: [] },
      { businessId: s.alpha, cause: 'window_unreadable', conversationIds: [] },
    ]);
    const text = JSON.stringify(failures);
    for (const foreign of [s.bravo.id, bravoDue, bravoCanary, alphaCanary]) {
      expect(text).not.toContain(foreign);
    }
  });
});
