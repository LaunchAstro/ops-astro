// SPDX-License-Identifier: AGPL-3.0-only
//
// R7: the idle sweep (AW-03, `sweepConversations`) run on a schedule over
// every business, and each failure a pass reports raised once per business
// and cause, with no body, title or error text in it or in the logs.
//
// Red before `apps/api/conversation-sweeper.ts`: nothing in apps/ ran the
// sweep, so no module answered these imports.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONVERSATION_SWEEP_EVERY_MS,
  startConversationSweeper,
  sweepRound,
  type SweepFailure,
} from '../../apps/api/conversation-sweeper.ts';
import {
  purgeConversation,
  sweepConversations,
  writeWrapUp,
  type SweepReport,
  type SweepRequest,
} from '../../packages/core-commands/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { started } from './aw-03-fixture.ts';
import {
  consoleLines,
  gatedSweep,
  pause,
  raisedFailures,
  REVISION,
  sweeperWorld,
  type SweeperWorld,
} from './r7-sweeper-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const canary = `CANARY-${randomUUID()}`;
let s: SweeperWorld;
let second: Database;

const ignore = (): void => {
  // A round whose failures the case does not look at.
};

function alphaRound(
  raise: (failure: SweepFailure) => void,
  lockTimeoutMs?: number,
): () => Promise<void> {
  return sweepRound(s.db, {
    businesses: async () => await Promise.resolve([s.alpha]),
    codeRevision: REVISION,
    raise,
    ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
  });
}

/** Whatever earlier cases left due is purged, so each case's failures are its own. */
async function settle(): Promise<void> {
  await s.window(s.alpha, 7);
  const round = alphaRound(ignore);
  await round();
  await round();
}

/** A conversation with the canary in its title and body, eight days quiet. */
async function plantedConversation(): Promise<string> {
  const id = await started(s.w, s.w.owner, {
    title: `Title ${canary}`,
    body: `${canary} the supplier's private quote`,
  });
  await s.w.age(id, 8);
  return id;
}

async function scheduleCase(): Promise<void> {
  await settle();
  expect(CONVERSATION_SWEEP_EVERY_MS).toBe(3_600_000);
  const due = await s.dueInAlpha('Due on the schedule.');
  const dueInBravo = await s.dueInBravo('Due in Bravo on the schedule.');
  const gated = gatedSweep();
  const sweeper = startConversationSweeper(s.db, {
    businesses: async () => await Promise.resolve([s.alpha, s.bravo.id]),
    codeRevision: REVISION,
    sweep: gated.sweep,
    everyMs: 20,
  });
  try {
    await pause(250);
    // A dozen ticks came due while the first pass waited: none started another.
    expect(gated.calls).toEqual([s.alpha]);
    gated.open();
    await expect
      .poll(async () => [await s.messages(due), await s.messages(dueInBravo)], { timeout: 10_000 })
      .toEqual([0, 0]);
  } finally {
    await sweeper.stop();
  }
  expect(gated.widest()).toBe(1);
  // Round by round: Alpha, then Bravo, then Alpha again.
  expect(gated.calls.every((id, at) => id === (at % 2 === 0 ? s.alpha : s.bravo.id))).toBe(true);
}

/** The held conversation's failure, then the window's, each once while it lasts. */
async function raiseFailures(stuck: string, raise: (failure: SweepFailure) => void): Promise<void> {
  const round = alphaRound(raise, 200);
  await second.withBusiness(s.alpha, async (tx) => {
    // A real operation holds the conversation past the pass's lock timeout.
    const held = await purgeConversation(tx, { conversationId: stuck, operationId: randomUUID() });
    expect(held).toEqual({ ok: false, code: 'WRAP_UP_ABSENT' });
    await round();
    await round();
  });
  await s.window(s.alpha, 3);
  await round();
  await round();
  // A pass without the cause closes it; the next one with it raises it again.
  await s.window(s.alpha, 7);
  await round();
  await s.window(s.alpha, 3);
  await round();
}

/** `rounds` while a real operation on a second connection holds the conversation's row. */
async function heldThrough(conversationId: string, rounds: () => Promise<void>): Promise<void> {
  await second.withBusiness(s.alpha, async (tx) => {
    const held = await writeWrapUp(tx, { conversationId, codeRevision: REVISION });
    expect(held).toMatchObject({ ok: true, written: false });
    await rounds();
  });
}

/**
 * A wrapped conversation due for its purge, held past the lock timeout through
 * two passes, then let go and purged; then another, held through one.
 */
async function purgeFailures(raise: (failure: SweepFailure) => void): Promise<string[]> {
  const round = alphaRound(raise, 200);
  const first = await s.dueInAlpha('Held through its purge.');
  await round();
  await heldThrough(first, async () => {
    await round();
    await round();
  });
  await round();
  const again = await s.dueInAlpha('Held through its purge after the first was purged.');
  await round();
  await heldThrough(again, round);
  await round();
  expect([await s.messages(first), await s.messages(again)]).toEqual([0, 0]);
  return [first, again];
}

async function failureCase(): Promise<void> {
  await settle();
  const { failures, raise } = raisedFailures();
  const logged = consoleLines();
  let purges: string[] = [];
  let stuck = '';
  try {
    purges = await purgeFailures(raise);
    stuck = await plantedConversation();
    await raiseFailures(stuck, raise);
    // The default raise logs the cause alone.
    await sweepRound(s.db, {
      businesses: async () => await Promise.resolve([s.alpha]),
      codeRevision: REVISION,
    })();
  } finally {
    logged.restore();
    await s.window(s.alpha, 7);
  }
  const window = { businessId: s.alpha, cause: 'window_unreadable', conversationIds: [] };
  expect(failures).toEqual([
    ...purges.map((id) => ({ businessId: s.alpha, cause: 'purge', conversationIds: [id] })),
    { businessId: s.alpha, cause: 'wrap_up', conversationIds: [stuck] },
    window,
    window,
  ]);
  expect(logged.text()).toContain('conversation sweep:');
  for (const text of [JSON.stringify(failures), logged.text()]) expect(text).not.toContain(canary);
  for (const id of [s.alpha, stuck, ...purges]) expect(logged.text()).not.toContain(id);
}

const breaking =
  (broken: string) =>
  async (database: Database, request: SweepRequest): Promise<SweepReport> => {
    if (request.businessId === broken) throw new Error(`${canary} in the error's text`);
    return await sweepConversations(database, request);
  };

/** The first round cannot read its businesses and every raise throws: the ticks go on. */
async function ticksOutlive(broken: string): Promise<number> {
  let asked = 0;
  const sweeper = startConversationSweeper(s.db, {
    businesses: async () => {
      asked += 1;
      if (asked === 1) throw new Error(canary);
      return await Promise.resolve([broken]);
    },
    codeRevision: REVISION,
    sweep: breaking(broken),
    raise: () => {
      throw new Error(canary);
    },
    everyMs: 20,
  });
  await expect.poll(() => asked, { timeout: 5_000 }).toBeGreaterThanOrEqual(3);
  await sweeper.stop();
  return asked;
}

async function oneFailingCase(): Promise<void> {
  await settle();
  const due = await s.dueInAlpha('Due beside a failing business.');
  const broken = randomUUID();
  const { failures, raise } = raisedFailures();
  const logged = consoleLines();
  try {
    const round = sweepRound(s.db, {
      businesses: async () => await Promise.resolve([broken, s.alpha]),
      codeRevision: REVISION,
      raise,
      sweep: breaking(broken),
    });
    await round();
    await round();
    expect(await s.messages(due)).toBe(0);
    expect(failures).toEqual([{ businessId: broken, cause: 'pass', conversationIds: [] }]);
    expect(await ticksOutlive(broken)).toBeGreaterThanOrEqual(3);
  } finally {
    logged.restore();
  }
  expect(logged.text()).not.toContain(canary);
}

async function stopCase(): Promise<void> {
  await settle();
  const gated = gatedSweep();
  const sweeper = startConversationSweeper(s.db, {
    businesses: async () => await Promise.resolve([s.alpha, s.bravo.id]),
    codeRevision: REVISION,
    sweep: gated.sweep,
    everyMs: 20,
  });
  await expect.poll(() => gated.calls.length, { timeout: 5_000 }).toBe(1);
  let stopped = false;
  const stopping = (async () => {
    await sweeper.stop();
    stopped = true;
  })();
  await pause(150);
  expect(stopped, 'stop resolved under a running pass').toBe(false);
  gated.open();
  await stopping;
  expect(gated.calls).toEqual([s.alpha]);
  await pause(150);
  expect(gated.calls, 'a pass started after stop').toEqual([s.alpha]);
}

describe.skipIf(serverUrl === undefined)('R7 conversation sweeper', () => {
  beforeAll(async () => {
    s = await sweeperWorld('r7_sweeper');
    second = connect(s.w.fixture.db.appUrl, { source: 'runtime' });
    await s.window(s.alpha, 7);
  }, 120_000);

  afterAll(async () => {
    await second?.close();
    await s?.w.drop();
  });

  it(
    'R7 on its interval every business is swept once a round, and a round never overlaps a running one',
    scheduleCase,
  );
  it(
    'R7 each failure a pass reports is raised once for its business and cause, with no body in it',
    failureCase,
  );
  it(
    'R7 one business failing does not stop the others, and the schedule outlives a thrown round',
    oneFailingCase,
  );
  it('R7 stop starts no round or business after it and waits for the pass in flight', stopCase);
});
