// SPDX-License-Identifier: AGPL-3.0-only
//
// #2321: a write-off at nothing recorded before #2282 stopped no replacement the
// reconciliation pass had already reserved for the step. #2313 refuses its pickup, but the
// queue still offered it to the agent and its hold stayed held. The queue reads the one
// written-off fact (`step-written-off.ts`), and the pass stops such a replacement as a write-off
// does today (`stopReplacement`): its lease ends, its delegation is revoked and its hold goes
// back. Another business's replacement, for a step not written off there, stays held and
// offered, whatever this business's register names.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passDeployment, registerEffectLookup } from '../../apps/api/recovery-entry.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import { aRealWriteOff, plantWriteOff, writtenOffBefore2282 } from './legacy-write-off-world.ts';
import {
  appliedDetail,
  asAgent,
  openSchedules,
  seedSchedules,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import type { Work } from './t2d-harness.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';
import { spend } from './version-room-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/a-replacement-held-for-a-step-written-off-before-2282-goes-back: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;
let other: Schedules;
const h = t3d1Harness(() => s);
const ho = t3d1Harness(() => other);

/** Billing, manage and gate decide for the decider. */
async function open(opened: Schedules): Promise<Schedules> {
  await openBilling(opened);
  await opened.db.app.withBusiness(opened.business, async (tx) => {
    await grantTo(tx, opened.decider, 'manage');
    await grantTo(tx, opened.decider, 'decide', undefined, false, 'gate');
  });
  return opened;
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await open(await openSchedules('legacy_replacement', 1_000_000));
  // The other business is a second tenant of the same database, so one pass reaches both.
  other = await open(await seedSchedules(s.db, 'legacy_replacement_other', 1_000_000));
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** The pass as the API runs it on its interval, over both businesses. */
async function pass(): Promise<void> {
  const keys = new Map([
    ['alpha', s.business],
    ['bravo', other.business],
  ]);
  const passed = await passDeployment(
    s.db.app,
    async (key) => await Promise.resolve(keys.get(key)),
    [...keys.keys()],
    registerEffectLookup,
  );
  expect(passed).toMatchObject({ ok: true });
}

/** The holds the agent's queue offers in `at`. */
async function offered(at: Schedules): Promise<readonly unknown[]> {
  const read = appliedDetail(
    await asAgent(at, { command: 'task.queue', operationId: randomUUID() }),
    'task.queue',
  );
  return (read['queue'] as readonly { readonly reservationId: unknown }[]).map(
    (entry) => entry.reservationId,
  );
}

/**
 * Held unknown after spending 300; the pass proves its effect absent and reserves a
 * replacement on its own hold, which `took` may pick up before anything else.
 */
async function replaced(at: Schedules, took: boolean) {
  const harness = at === s ? h : ho;
  const w = await harness.unknownStep({ applied: false, room: true });
  await spend(at, w.decision['reservationId'], 300);
  await harness.reconcile();
  const replacement = await harness.replacement(w);
  expect(replacement).toBeDefined();
  const picked = took
    ? appliedDetail(
        await asAgent(at, {
          command: 'task.pickup',
          operationId: randomUUID(),
          reservationId: replacement,
          leaseSeconds: 600,
        }),
        'task.pickup',
      )
    : undefined;
  return { w, replacement: String(replacement), picked };
}

/** The replacement's hold and attempt, and the envelope the step shares. */
async function moneyOf(at: Schedules, w: Work, replacement: string) {
  const harness = at === s ? h : ho;
  const hold = (await harness.holds(w)).find((one) => one['id'] === replacement);
  return { hold, envelope: await harness.envelope(w) };
}

/** What the envelope holds once the replacement's hold has gone back. */
const given = (before: Awaited<ReturnType<typeof moneyOf>>): string =>
  String(Number(before.envelope?.['held']) - Number(before.hold?.['held']));

/** The lease and delegation a pickup of the replacement took. */
async function claimOf(at: Schedules, picked: Detail) {
  const [claim] = await rows<{ lease: string; revoked: boolean; cause: string | null }>(
    at,
    `select l.state as lease, d.revoked_at is not null as revoked, d.revocation_cause as cause
       from public.leases l
       join public.delegations d on d.business_id = l.business_id and d.id = $3
      where l.business_id = $1 and l.id = $2`,
    [at.business, picked['leaseId'], picked['delegationId']],
  );
  return claim;
}

const legacy = 'a replacement held for a step written off at nothing before #2282';

describe.skipIf(serverUrl === undefined)(legacy, () => {
  it('is off the queue, and the next pass gives its hold back once', async () => {
    const template = await aRealWriteOff(s);
    const { w, replacement } = await replaced(s, false);
    await writtenOffBefore2282(
      s,
      { reservationId: w.decision['reservationId'], attemptId: w.attemptId, taskId: w.taskId },
      template,
    );
    const before = await moneyOf(s, w, replacement);
    expect(before.hold).toMatchObject({ state: 'held', attempt_state: 'reserved' });

    const queued = await offered(s);
    await pass();
    const after = await moneyOf(s, w, replacement);
    const snapshot = await h.t3b.snapshot();
    await pass();
    expect({
      queued: queued.includes(replacement),
      hold: after.hold,
      envelope: after.envelope,
      again: await h.t3b.snapshot(),
    }).toEqual({
      queued: false,
      hold: { ...before.hold, state: 'abandoned', actual: null, attempt_state: 'abandoned' },
      envelope: { ...before.envelope, held: given(before) },
      again: snapshot,
    });
  });
});

describe.skipIf(serverUrl === undefined)(`${legacy}, picked up first`, () => {
  it('picked up before the write-off, its lease ends at the next pass and its hold goes back', async () => {
    const template = await aRealWriteOff(s);
    const { w, replacement, picked } = await replaced(s, true);
    await writtenOffBefore2282(
      s,
      { reservationId: w.decision['reservationId'], attemptId: w.attemptId, taskId: w.taskId },
      template,
    );
    const before = await moneyOf(s, w, replacement);
    expect(before.hold).toMatchObject({ state: 'held', attempt_state: 'dispatched' });

    await pass();
    expect({
      money: await moneyOf(s, w, replacement),
      claim: await claimOf(s, picked as Detail),
    }).toEqual({
      money: {
        hold: { ...before.hold, state: 'abandoned', actual: null, attempt_state: 'abandoned' },
        envelope: { ...before.envelope, held: given(before) },
      },
      claim: { lease: 'released', revoked: true, cause: 'work_retired' },
    });
  });
});

describe.skipIf(serverUrl === undefined)(`${legacy}, in another business`, () => {
  it("stays held and offered in another business, whatever this business's register names", async () => {
    const template = await aRealWriteOff(s);
    const { w, replacement } = await replaced(other, false);
    // This business's register names the other business's first attempt as written off.
    await s.db.app.withBusiness(s.business, async (tx) => {
      await plantWriteOff(tx, template, { attemptId: w.attemptId, taskId: w.taskId });
    });
    const before = await moneyOf(other, w, replacement);
    // The pass's own database holds the other business's replacement (S2335-1).
    const seen = await rows<{ business_id: string; state: string }>(
      s,
      'select business_id, state from public.reservations where id = $1',
      [replacement],
    );
    expect(seen).toEqual([{ business_id: other.business, state: 'held' }]);

    await pass();
    expect({
      money: await moneyOf(other, w, replacement),
      queued: (await offered(other)).includes(replacement),
    }).toEqual({ money: before, queued: true });
  });
});
