// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's first review of PR #365 (C80's live correction records): five
// findings, each one proof on a real database through the application role,
// in a world of its own opened by round 1's `describeWorld`
// (`live-correction-lows.ts`).
//
//   1. Criterion 3: a grant revoked, or expired, while a covered lock waits
//      covers nothing once the lock is held.
//   2. Criterion 5: the latest publish receipt is the one written last, not
//      the one whose transaction started last.
//
// Registered through `tests/tenancy/restricted-calls.test.ts`, a named suite,
// which calls `describeLiveCorrectionSolRoundOne` after round 2.

import { describe, expect, it } from 'vitest';
import { enrol, grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  awaitParked,
  barrier,
  holdRows,
  racer,
  startedBefore,
  waitPast,
} from '../runtime/schedules-harness.ts';
import {
  lockCoveredCorrection,
  readCorrectionForRun,
  recordObservedResult,
} from '../../packages/core-records/src/site/index.ts';
import type { Scope, Subject } from '../../packages/core-records/src/authority/grants.ts';
import { describeWorld, filed, inBusiness, lows } from './live-correction-lows.ts';
import { observedPublish } from './live-correction-lows-cancel.ts';

/** A fresh member and the grants it holds: run:write and gate:decide at `scope`. */
async function holder(
  name: string,
  scope: Scope,
): Promise<{ member: Member; grants: readonly string[] }> {
  const { s } = lows();
  const member = await enrol(s.db.app, s.business, name);
  const grants = await s.db.app.withBusiness(s.business, async (tx) => [
    await grantTo(tx, member, 'write', scope, false, 'run'),
    await grantTo(tx, member, 'decide', scope, false, 'gate'),
  ]);
  return { member, grants };
}

const subjectsOf = (member: Member): readonly Subject[] => [
  { kind: 'person', id: member.personId },
];

const GRANT_EXPIRES = 'select expires_at from public.grants where id = $1';

/** `member`'s covered lock on `id`, parked on the row held elsewhere while `meanwhile` runs. */
async function lockedAcross(
  id: string,
  member: Member,
  meanwhile: () => Promise<void>,
): Promise<boolean> {
  const { s } = lows();
  const locker = racer(s);
  const held = await holdRows(s, 'live_corrections', [id]);
  try {
    const covering = { subjects: subjectsOf(member), collection: 'gate', action: 'decide' };
    const locking = locker.withBusiness(
      s.business,
      async (tx) => (await lockCoveredCorrection(tx, id, covering)) !== undefined,
    );
    await awaitParked(s, 'live_corrections', 1);
    await meanwhile();
    await held.release();
    return await locking;
  } finally {
    await held.release().catch(() => null);
    await locker.close();
  }
}

function findingOne(): void {
  it('Sol R1 1: authority lost by revocation or expiry while a covered lock waits is refused', async () => {
    const { s } = lows();
    const { id } = await filed();
    const [kept, revoked, expiring] = [
      await holder('kept', WHOLE_BUSINESS),
      await holder('revoked', WHOLE_BUSINESS),
      await holder('expiring', WHOLE_BUSINESS),
    ];
    // The control: a grant that stays live covers the row across the same wait.
    expect(await lockedAcross(id, kept.member, async () => await Promise.resolve())).toBe(true);
    const revoke = async () => {
      await s.db.admin.execute(
        `update public.grants set revoked_at = greatest(now(), granted_at)
          where id = any($1::uuid[])`,
        [revoked.grants],
      );
    };
    const afterRevoking = await lockedAcross(id, revoked.member, revoke);
    await s.db.admin.execute(
      `update public.grants set expires_at = clock_timestamp() + interval '3 seconds'
        where id = any($1::uuid[])`,
      [expiring.grants],
    );
    const expire = async () => {
      expect(await startedBefore(s, GRANT_EXPIRES, expiring.grants[1])).toBe(true);
      await waitPast(s, GRANT_EXPIRES, expiring.grants[1]);
    };
    const afterExpiring = await lockedAcross(id, expiring.member, expire);
    expect({ afterRevoking, afterExpiring }).toStrictEqual({
      afterRevoking: false,
      afterExpiring: false,
    });
  }, 30_000);
}

function findingTwo(): void {
  it('Sol R1 2: the latest publish follows receipt write order when transactions start out of order', async () => {
    const { s } = lows();
    const { id } = await filed('approved');
    const [started, go] = [barrier(), barrier()];
    const early = racer(s);
    try {
      // The earlier transaction starts first and writes its receipt last.
      const writtenLast = early.withBusiness(s.business, async (tx) => {
        await tx.query('select 1');
        started.release();
        await go.held;
        return await recordObservedResult(tx, observedPublish(id, 'live'));
      });
      await Promise.race([started.held, writtenLast]);
      const first = await inBusiness(
        async (tx) => await recordObservedResult(tx, observedPublish(id, 'accepted')),
      );
      expect(first).toMatchObject({ ok: true, state: 'accepted' });
      go.release();
      expect(await writtenLast).toMatchObject({ ok: true, state: 'live' });
    } finally {
      go.release();
      await early.close();
    }
    const run = await inBusiness(
      async (tx) => await readCorrectionForRun(tx, observedPublish(id, 'live')),
    );
    expect(run).toMatchObject({ ok: true, lastPublish: { seen: 'live' } });
  });
}

/** Sol's first review's findings, each its own block over one world. */
export function describeLiveCorrectionSolRoundOne(): void {
  describeWorld('P26 Sol R1: the live correction records', 'p26sol1', () => {
    describe('Sol R1 1: authority judged after the lock', findingOne);
    describe('Sol R1 2: receipts in write order', findingTwo);
  });
}
