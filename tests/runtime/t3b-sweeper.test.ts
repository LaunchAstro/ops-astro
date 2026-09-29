// SPDX-License-Identifier: AGPL-3.0-only
//
// T3b, the sweeper and the unknown liability, over a real database.
//
// `unknown_stays_unknown` (split 2.2, T3-N7): driven by the declining usage
// reporter handed in at construction, a dispatched attempt whose lease runs
// out becomes `liability_unknown` with the whole hold kept, and advancing
// every timer past every window leaves it unchanged. Red until T2c1 can mark
// dispatch; red if any timer path writes a settled or released state.
//
// The rest of T3b's checklist, one case each: the sweep releases in full, by
// amount, a hold whose step was never marked and whose lease has run out; it
// never releases a hold awaiting pickup or held by a live lease; it races
// dispatch with exactly one winner; after a mark it holds the step unknown
// without asking the operation register; a legacy quarantined row stays
// quarantined and a new marked row is never quarantined; a database seeded
// through first-slice operations is unchanged, or classified by name. The API
// runs the pass per business, in its own transaction. Separations: business
// to business (one business's sweep leaves another's holds untouched and
// raises its unknown cost only at home), client to client and person to
// person (the unknown amount reaches only a reader holding the task grant).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { sweepExpiredLeases } from '../../packages/core-runtime/src/index.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import { sweepDeployment } from '../../apps/api/recovery-entry.ts';
import { DECLINING_REPORTER } from '../support/declining-reporter.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  capCommitted,
  codeOf,
  createTask,
  freshPurpose,
  handbackBody,
  openSchedules,
  propose,
  racer,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import { cq8World } from './t2d-harness.ts';
import { resolve as resolvePath } from 'node:path';
import { readIdentity } from '../../apps/api/identity.ts';
import { createApiFixture, type ApiFixture } from '../api/fixture.ts';
import {
  onLease,
  openSecond,
  recordingTransactions,
  t3bHarness,
  workerWorld,
  type WorkerWorld,
} from './t3b-harness.ts';

const ROOT = resolvePath(import.meta.dirname, '../..');

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t3b-sweeper: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('T3b the sweeper and the unknown liability', () => {
  let s: Schedules;
  let other: Schedules;
  const alpha = t3bHarness(() => s);
  const bravo = t3bHarness(() => other);

  beforeAll(async () => {
    s = await openSchedules('t3b', 1_000_000);
    other = await openSecond(s, 'bravo');
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('the synthetic reporter settles, and the sweep leaves a settled attempt settled', async () => {
    const w = await alpha.work();
    await alpha.reported(w, SYNTHETIC_USAGE);
    await alpha.expire(w);
    const settled = await alpha.money(w);
    expect(settled).toMatchObject({ state: 'actual', attempt_state: 'settled' });
    expect(await alpha.sweep()).toStrictEqual([]);
    expect(await alpha.money(w)).toStrictEqual(settled);
  });

  it('releases in full, by amount, a hold never marked whose lease has run out', async () => {
    const w = await alpha.work();
    const capBefore = await capCommitted(s);
    await alpha.expire(w);
    const swept = await alpha.sweep();
    expect(swept).toStrictEqual([expect.objectContaining({ released: true, state: 'abandoned' })]);
    expect(await alpha.money(w)).toMatchObject({
      state: 'abandoned',
      classified_cause: 'lease_expired_and_fenced',
      attempt_state: 'abandoned',
      dispatch_marker: false,
      envelope_held: '0',
      envelope_actual: '0',
      lease_state: 'expired',
    });
    expect(capBefore - (await capCommitted(s))).toBe(2_500);
    // The fenced lease dispatches nothing afterwards.
    expect(codeOf(await onLease(s, w, { command: 'task.dispatch' }))).toMatch(/^LEASE_/u);
  });

  it('never releases a hold awaiting pickup or one held by a live lease', async () => {
    const taskId = await createTask(s, `t3b waiting ${randomUUID()}`);
    await approve(s, await propose(s, taskId, { maximumMinor: 700, purpose: freshPurpose() }));
    const live = await alpha.work();
    const before = await alpha.snapshot();
    expect(await alpha.sweep()).toStrictEqual([]);
    expect(await alpha.snapshot()).toStrictEqual(before);
    expect(await alpha.money(live)).toMatchObject({ state: 'held', lease_state: 'live' });
  });

  it('after a mark it holds the step unknown without asking the operation register', async () => {
    const w = await alpha.work();
    await alpha.dispatched(w);
    expect(await alpha.effects(w)).toBe(0);
    await alpha.expire(w);
    expect(await alpha.sweep()).toStrictEqual([
      expect.objectContaining({ released: false, state: 'liability_unknown' }),
    ]);
    expect(await alpha.money(w)).toMatchObject({
      state: 'held',
      held: '2500',
      attempt_state: 'liability_unknown',
      dispatch_marker: true,
    });
    expect(await alpha.effects(w)).toBe(0);
  });

  it('races dispatch with exactly one winner', async () => {
    for (let round = 0; round < 3; round += 1) {
      // Sequential rounds: each races its own lease.
      // eslint-disable-next-line no-await-in-loop
      const w = await alpha.work();
      // eslint-disable-next-line no-await-in-loop
      await s.db.admin.execute(
        `update public.leases set expires_at = clock_timestamp() + interval '150 milliseconds'
          where business_id = $1 and id = $2`,
        [s.business, w.picked['leaseId']],
      );
      const a = racer(s);
      const sweepUntilFenced = async (): Promise<void> => {
        for (let tries = 0; tries < 200; tries += 1) {
          // eslint-disable-next-line no-await-in-loop
          const done = await a.withBusiness(s.business, async (tx) => {
            await sweepExpiredLeases(tx);
            const [lease] = await tx.query<{ readonly state: string }>(
              `select state from public.leases where business_id = $1 and id = $2`,
              [s.business, w.picked['leaseId']],
            );
            return lease?.state !== 'live';
          });
          if (done) return;
        }
      };
      // eslint-disable-next-line no-await-in-loop
      const [dispatch] = await Promise.all([
        onLease(s, w, { command: 'task.dispatch' }),
        sweepUntilFenced(),
      ]);
      // eslint-disable-next-line no-await-in-loop
      await a.close();
      // eslint-disable-next-line no-await-in-loop
      const after = await alpha.money(w);
      // Exactly one winner: a mark held unknown, or a release with no mark.
      expect(after).toMatchObject(
        codeOf(dispatch) === 'applied'
          ? { state: 'held', attempt_state: 'liability_unknown' }
          : { state: 'abandoned', dispatch_marker: false },
      );
      expect(after?.['lease_state']).toBe('expired');
    }
  });

  it('keeps quarantine for a legacy marked row, and a new marked row is never quarantined', async () => {
    const legacy = await alpha.work();
    await s.db.admin.execute(
      `update public.attempts set dispatch_marker = true, state = 'quarantined'
        where business_id = $1 and reservation_id = $2`,
      [s.business, legacy.decision['reservationId']],
    );
    const fresh = await alpha.work();
    await alpha.dispatched(fresh);
    await alpha.expire(legacy);
    await alpha.expire(fresh);
    await alpha.sweep();
    expect(await alpha.money(legacy)).toMatchObject({
      state: 'quarantined',
      attempt_state: 'quarantined',
    });
    expect(await alpha.money(fresh)).toMatchObject({ attempt_state: 'liability_unknown' });
    const both = await rows(
      s,
      `select 1 from public.attempts att
         join public.planned_steps step on step.business_id = att.business_id
          and step.dispatch_attempt_id = att.id
        where att.business_id = $1 and att.state = 'quarantined'`,
      [s.business],
    );
    expect(both).toHaveLength(0);
  });

  it('a database seeded through first-slice operations is unchanged, or classified by name', async () => {
    const handed = await alpha.work();
    appliedDetail(
      await asAgent(s, handbackBody(handed.picked), handed.credential),
      'task.handback',
    );
    const cancelled = await alpha.work();
    appliedDetail(
      await asPerson(s, {
        command: 'task.cancel',
        operationId: randomUUID(),
        recordId: cancelled.taskId,
        lineageId: cancelled.proposal['lineageId'],
        reason: 'no longer needed',
      }),
      'task.cancel',
    );
    const before = await alpha.snapshot();
    expect(await alpha.sweep()).toStrictEqual([]);
    expect(await alpha.snapshot()).toStrictEqual(before);

    const aged = await alpha.work();
    await alpha.expire(aged);
    const [classified] = await alpha.sweep();
    expect(classified?.reason).toContain('lease_expired_and_fenced');
  });

  it('business to business: a sweep in one business leaves another untouched and raises only at home', async () => {
    const home = await alpha.work();
    await alpha.dispatched(home);
    const away = await bravo.work();
    await bravo.dispatched(away);
    await alpha.expire(home);
    await bravo.expire(away);
    const awayBefore = await bravo.snapshot();

    await alpha.sweep();
    expect(await alpha.money(home)).toMatchObject({ attempt_state: 'liability_unknown' });
    expect(await bravo.snapshot()).toStrictEqual(awayBefore);
    expect(await bravo.money(away)).toMatchObject({ attempt_state: 'dispatched', state: 'held' });

    // The API's pass: each business in its own transaction, by configured key.
    const keys = new Map([
      ['alpha', s.business],
      ['bravo', other.business],
    ]);
    const resolve = async (key: string): Promise<string | undefined> =>
      await Promise.resolve(keys.get(key));
    const homeTwo = await alpha.work();
    await alpha.dispatched(homeTwo);
    await alpha.expire(homeTwo);
    const pass = recordingTransactions(s.db.app);
    const outcome = await sweepDeployment(pass.database, resolve, ['alpha', 'bravo']);
    expect(outcome).toMatchObject({ ok: true, businesses: [{ key: 'alpha' }, { key: 'bravo' }] });
    // One transaction per business, each opened under its own business.
    expect(pass.opened.map((one) => one.businessId)).toStrictEqual([s.business, other.business]);
    expect(new Set(pass.opened.map((one) => one.txid)).size).toBe(2);
    expect(await alpha.money(homeTwo)).toMatchObject({ attempt_state: 'liability_unknown' });
    expect(await bravo.money(away)).toMatchObject({ attempt_state: 'liability_unknown' });
    const unknownIn = async (business: string) =>
      await rows(
        s,
        `select id from public.attempts where business_id = $1 and state = 'liability_unknown'`,
        [business],
      );
    expect(await unknownIn(other.business)).toHaveLength(1);
    expect((await sweepDeployment(s.db.app, resolve, ['nobody'])).ok).toBe(false);
  });

  it('client to client and person to person: the unknown amount reaches only a reader holding the task grant', async () => {
    const w = await alpha.work();
    await alpha.reported(w, DECLINING_REPORTER);
    await alpha.expire(w);
    await alpha.sweep();
    const readAs = async (who: Member, recordId = w.taskId) =>
      await executeRead(s.db.app, s.business, who.presented, {
        read: 'task.read',
        recordId,
      } as never);
    expect(JSON.stringify(await readAs(s.decider))).toContain('"state":"liability_unknown"');

    // Business to business: another business's member names this task from home.
    const foreign = await executeRead(s.db.app, other.business, other.decider.presented, {
      read: 'task.read',
      recordId: w.taskId,
    } as never);
    expect(foreign).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(foreign)).not.toMatch(/liability_unknown|2500/u);

    const idle = await enrol(s.db.app, s.business, `t3b-idle-${randomUUID()}`);
    expect(await readAs(idle)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });

    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, s.decider, 'share');
    });
    const otherTask = await createTask(s, `t3b other client ${randomUUID()}`);
    const own = await cq8World(s).client(
      s.business,
      s.decider,
      `t3b-own-${randomUUID()}`,
      w.taskId,
    );
    const wrong = await cq8World(s).client(
      s.business,
      s.decider,
      `t3b-wrong-${randomUUID()}`,
      otherTask,
    );
    expect(JSON.stringify(await readAs(own))).not.toMatch(/liability_unknown|heldMinor|2500/u);
    const crossed = await readAs(wrong);
    expect(crossed).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(crossed)).not.toMatch(/liability_unknown|2500/u);
  });
});

describe.skipIf(serverUrl === undefined)('unknown_stays_unknown through the worker', () => {
  let fixture: ApiFixture;
  let world: WorkerWorld;

  beforeAll(async () => {
    fixture = await createApiFixture('t3b_worker');
    world = workerWorld(fixture, fixture.compose(undefined, readIdentity(ROOT)));
  }, 120_000);

  afterAll(async () => {
    await fixture?.db.drop();
  });

  it('unknown_stays_unknown: a dispatched, unreported attempt is held unknown at its maximum, and every timer past every window leaves it so', async () => {
    // The worker is constructed with the declining reporter: it dispatches,
    // applies the one comment and observes, and its reporter never says what
    // the step cost, so nothing settles.
    const taskId = await world.applies({ reporter: DECLINING_REPORTER });
    expect(await world.money(taskId)).toMatchObject({
      state: 'held',
      attempt_state: 'dispatched',
      dispatch_marker: true,
      observed: true,
      lease_state: 'live',
    });

    await world.pastEveryWindow();
    expect(await world.sweep()).toStrictEqual([
      expect.objectContaining({ released: false, state: 'liability_unknown' }),
    ]);
    const unknown = await world.money(taskId);
    expect(unknown).toMatchObject({
      state: 'held',
      held: '2500',
      actual: null,
      attempt_state: 'liability_unknown',
      envelope_held: '2500',
      envelope_actual: '0',
      lease_state: 'expired',
    });

    // Every timer past every window again, then the sweep and the restart
    // replay, three times over: no timer path settles or releases it.
    for (let round = 0; round < 3; round += 1) {
      // Sequential: each round reads what the one before committed.
      // eslint-disable-next-line no-await-in-loop
      await world.pastEveryWindow();
      // eslint-disable-next-line no-await-in-loop
      expect(await world.sweep()).toStrictEqual([]);
      // eslint-disable-next-line no-await-in-loop
      expect(await world.replay()).toStrictEqual([]);
    }
    expect(await world.money(taskId)).toStrictEqual(unknown);
  });
});
