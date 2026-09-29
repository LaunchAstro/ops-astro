// SPDX-License-Identifier: AGPL-3.0-only
//
// T2c1, the crash seam (spike RN-02). A named point parks the process after a
// commit so a test can kill it there, 50 of 50 times, rather than timing an
// outside kill. The seam is inert unless the test-only variable names a
// point, and it refuses to arm outside test mode, at start-up and at the
// point itself.

import { describe, expect, it } from 'vitest';
import {
  CRASH_POINT_VARIABLE,
  CRASH_POINTS,
  crashPoint,
  crashPointAfterCommit,
  crashSeamProblem,
} from '../../packages/core-runtime/src/crash-point.ts';

const settledWithin = async (work: Promise<void>, ms: number): Promise<boolean> =>
  await Promise.race([
    work.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), ms);
    }),
  ]);

describe('T2c1 the crash seam', () => {
  it('names one point after the reservation commits and one after the dispatch mark commits', () => {
    expect([...CRASH_POINTS].toSorted()).toStrictEqual(
      ['dispatch_committed', 'reservation_committed'].toSorted(),
    );
  });

  it('is inert when the variable is unset, empty, or names another point', async () => {
    for (const env of [{}, { [CRASH_POINT_VARIABLE]: '' }]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await settledWithin(crashPoint('dispatch_committed', env), 50)).toBe(true);
      expect(crashSeamProblem(env)).toBeUndefined();
    }
    const other = { [CRASH_POINT_VARIABLE]: 'reservation_committed', NODE_ENV: 'test' };
    expect(await settledWithin(crashPoint('dispatch_committed', other), 50)).toBe(true);
  });

  it('refuses to arm outside test mode, at start-up and at the point', async () => {
    const armed = { [CRASH_POINT_VARIABLE]: 'dispatch_committed', NODE_ENV: 'production' };
    expect(crashSeamProblem(armed)).toContain(CRASH_POINT_VARIABLE);
    await expect(crashPoint('dispatch_committed', armed)).rejects.toThrow(CRASH_POINT_VARIABLE);
    expect(crashSeamProblem({ [CRASH_POINT_VARIABLE]: 'nowhere', NODE_ENV: 'test' })).toContain(
      'nowhere',
    );
  });

  it('parks at the named point in test mode, and maps each committed command to its point', async () => {
    const armed = { [CRASH_POINT_VARIABLE]: 'dispatch_committed', NODE_ENV: 'test' };
    expect(await settledWithin(crashPoint('dispatch_committed', armed), 100)).toBe(false);
    expect(
      await settledWithin(crashPointAfterCommit('task.dispatch', { attemptId: 'a' }, armed), 100),
    ).toBe(false);
    expect(await settledWithin(crashPointAfterCommit('task.dispatch', undefined, armed), 50)).toBe(
      true,
    );
    const decide = { [CRASH_POINT_VARIABLE]: 'reservation_committed', NODE_ENV: 'test' };
    expect(
      await settledWithin(
        crashPointAfterCommit('task.decide', { reservationId: 'r' }, decide),
        100,
      ),
    ).toBe(false);
    // A rejection commits no reservation, so it answers rather than parking (Sol review 1).
    expect(
      await settledWithin(crashPointAfterCommit('task.decide', { decision: 'reject' }, decide), 50),
    ).toBe(true);
  });
});
