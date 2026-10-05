// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A: a revoke or a turn-off racing a dispatch, each on a connection of its
// own (the world's app pool holds one, which would serialise them first). The
// change holds the activation's lock in its open transaction until the
// dispatch waits on that lock, then commits; the dispatch, which rechecks the
// approval only once it holds the lock, must start nothing. The other order,
// a dispatch holding the lock while the revoke waits, starts its one run and
// the revoke stops every occurrence after it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connect,
  dispatchOccurrence,
  revokeApproval,
  turnOffActivation,
  type Database,
  type Dispatch,
  type RunStarter,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { firingOf, occurrenceOf, starter, waitingOn, type Firing } from './firing.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the races that share it
describe.skipIf(serverUrl === undefined)('C52-A dispatch races', () => {
  let w: AutomationWorld;
  let f: Firing;
  let changer: Database;
  let dispatcher: Database;

  beforeAll(async () => {
    w = await createAutomationWorld('c52d');
    f = firingOf(w);
    changer = connect(w.db.appUrl);
    dispatcher = connect(w.db.appUrl);
  });

  afterAll(async () => {
    await changer?.close();
    await dispatcher?.close();
    await w?.db.drop();
  });

  const inOwn = async <T>(pool: Database, run: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await pool.withBusiness(w.alpha, run);

  /** `change` runs in its own open transaction; the dispatch is sent and waits on it, then it commits. */
  const changeWhileDispatching = async (
    change: (tx: TenantQuery) => Promise<unknown>,
    occurrenceId: string,
    start: RunStarter,
  ): Promise<Dispatch> => {
    let sent: Promise<Dispatch> | undefined;
    await inOwn(changer, async (tx) => {
      await change(tx);
      sent = inOwn(dispatcher, (other) => dispatchOccurrence(other, occurrenceId, start));
      await waitingOn(w, 1);
    });
    if (sent === undefined) throw new Error('the dispatch was never sent');
    return await sent;
  };

  it('C52-A revoke racing dispatch: a revoke committed while the dispatch waits on its lock starts no run', async () => {
    const { activation, approval } = await f.approved();
    const held = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    expect(held.outcome).toBe('approved');
    const s = starter();
    const answer = await changeWhileDispatching(
      async (tx) => {
        expect(
          await revokeApproval(tx, { approvalId: approval.id, actorId: w.admin.actorId }),
        ).toBe('revoked');
      },
      held.id,
      s.start,
    );
    expect(answer).toEqual({
      kind: 'dispatched',
      dispatch: { occurrenceId: held.id, outcome: 'approval_revoked', runId: null },
    });
    expect(s.runs).toEqual([]);
    expect(await f.started(activation.id)).toBe(0);
  }, 60_000);

  it('C52-A turn-off racing dispatch: a turn-off committed while the dispatch waits on its lock starts no run', async () => {
    const { activation } = await f.approved();
    const held = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const s = starter();
    const answer = await changeWhileDispatching(
      async (tx) => {
        const off = await turnOffActivation(tx, {
          activationId: activation.id,
          expectedRevision: activation.revision,
          actorId: w.admin.actorId,
        });
        expect(off.kind).toBe('off');
      },
      held.id,
      s.start,
    );
    expect(answer).toEqual({
      kind: 'dispatched',
      dispatch: { occurrenceId: held.id, outcome: 'activation_off', runId: null },
    });
    expect(s.runs).toEqual([]);
  }, 60_000);

  it('C52-A dispatch before revoke: a dispatch holding the lock starts its run, the waiting revoke then stops the next occurrence', async () => {
    const { activation, approval } = await f.approved();
    const held = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const s = starter();
    let revoked: Promise<unknown> | undefined;
    // The starter runs with the lock held: the revoke is sent then, and waits.
    const slow: RunStarter = async (tx, run) => {
      revoked = inOwn(changer, (other) =>
        revokeApproval(other, { approvalId: approval.id, actorId: w.admin.actorId }),
      );
      await waitingOn(w, 1);
      return await s.start(tx, run);
    };
    const answer = await inOwn(dispatcher, (tx) => dispatchOccurrence(tx, held.id, slow));
    expect(answer.kind === 'dispatched' && answer.dispatch.outcome).toBe('started');
    expect(await revoked).toBe('revoked');
    const next = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    expect(next.outcome).toBe('no_standing_approval');
    expect(s.runs).toHaveLength(1);
    expect(await f.started(activation.id)).toBe(1);
  }, 60_000);
});
