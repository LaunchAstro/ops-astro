// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A: what a run, a release and an edit may not change, and the records'
// isolation over a real crossing, against a real database (U36). Bravo has
// its own definition, version, activation and standing approval; alpha's ids
// sent from bravo answer as unknown, and bravo's attempts change nothing and
// stop none of alpha's firing. Firing is in `c52a-firing.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adoptVersion,
  changeActivation,
  dispatchOccurrence,
  listApprovals,
  readActivation,
  readStandingApproval,
  readVersion,
  revokeApproval,
  rollbackTarget,
  turnOffActivation,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { bravoApproved, firingOf, occurrenceOf, starter, type Firing } from './firing.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** What the records answer for a row the business does not have, whether another's or none. */
const UNKNOWN_EVERYWHERE = [{ kind: 'unknown' }, { kind: 'unknown' }, 'unknown', null, [], null];

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C52-A pins', () => {
  let w: AutomationWorld;
  let f: Firing;

  beforeAll(async () => {
    w = await createAutomationWorld('c52p');
    f = firingOf(w);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  const inBravo = async <T>(run: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await w.db.app.withBusiness(w.bravo, run);

  /** Every records call bravo's admin can make with these ids, in bravo's own transaction. */
  const bravoTries = async (
    activationId: string,
    approvalId: string,
    at: { readonly versionId: string; readonly expectedRevision: number },
  ): Promise<readonly unknown[]> => {
    const actorId = w.bravoAdmin.actorId;
    const { versionId, expectedRevision } = at;
    return await inBravo(async (tx) => [
      await adoptVersion(tx, {
        activationId,
        versionId,
        expectedRevision,
        act: 'adopted',
        actorId,
      }),
      await turnOffActivation(tx, { activationId, expectedRevision, actorId }),
      await revokeApproval(tx, { approvalId, actorId }),
      await readStandingApproval(tx, activationId),
      await listApprovals(tx, activationId),
      await rollbackTarget(tx, activationId),
    ]);
  };

  it('C52-A no silent skill change: runs and a newer release leave the pin and its approval; an edit leaves no approval standing', async () => {
    const { version, activation, approval } = await f.approved();
    const s = await starter(w.db, w.alpha, w.bravo);
    await f.fire(activation.id, s.start);
    await f.fire(activation.id, s.start);
    await f.fire(activation.id, s.start);
    expect(s.runs.map((run) => run.versionId)).toEqual([version.id, version.id, version.id]);
    const newer = await w.release(['scheduled']);
    const now = await w.inAlpha((tx) => readActivation(tx, activation.id));
    expect(now).toMatchObject({ versionId: version.id, revision: activation.revision });
    expect(await w.inAlpha((tx) => readStandingApproval(tx, activation.id))).toMatchObject({
      id: approval.id,
      versionId: version.id,
    });
    expect(await w.inAlpha((tx) => readVersion(tx, version.id))).toEqual(version);
    // A settings edit that repoints the activation is not an adoption: nothing stands on the new pin.
    const edited = await w.inAlpha((tx) =>
      changeActivation(tx, activation.id, activation.revision, {
        versionId: newer.id,
        mode: 'scheduled',
        everyMinutes: 60,
        eventKind: null,
        enabled: true,
        actorId: w.admin.actorId,
      }),
    );
    expect(edited?.versionId).toBe(newer.id);
    expect(await w.inAlpha((tx) => readStandingApproval(tx, activation.id))).toBeNull();
    const after = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    expect(after).toMatchObject({ outcome: 'no_standing_approval', versionId: newer.id });
    expect(s.runs).toHaveLength(3);
  });

  it('C52-A no older approval named: a write may name only the adoption that wrote its revision', async () => {
    const first = await f.approved();
    const newer = await w.release(['scheduled']);
    const second = await f.adopt(first.activation, newer);
    // Pointing the activation back at the first adoption, at its own pin, is refused by the database.
    const back = w.inAlpha((tx) =>
      tx.query(
        `update public.activations set version_id = $2, approval_id = $3, revision = revision + 1
          where id = $1`,
        [first.activation.id, first.version.id, first.approval.id],
      ),
    );
    await expect(back).rejects.toThrow(/activations_approval_stands|did not write revision/u);
    expect(await w.inAlpha((tx) => readStandingApproval(tx, first.activation.id))).toMatchObject({
      id: second.approval.id,
    });
  });

  it('C52-A isolation: another business’s activation, approval and occurrence answer as unknown to the records', async () => {
    const canary = `c52a-bravo-${randomUUID()}`;
    const bravo = await bravoApproved(w, 'scheduled', `Bravo digest ${canary}`);
    const { activation, approval } = await f.approved();
    const occurrence = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const s = await starter(w.db, w.alpha, w.bravo);
    for (const [activationId, approvalId] of [
      [activation.id, approval.id],
      [randomUUID(), randomUUID()],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- alpha's ids, then fabricated ones, alike
      const answers = await bravoTries(activationId, approvalId, {
        versionId: approval.versionId,
        expectedRevision: activation.revision,
      });
      expect(answers).toEqual(UNKNOWN_EVERYWHERE);
    }
    expect(await inBravo((tx) => dispatchOccurrence(tx, occurrence.id, s.start))).toEqual({
      kind: 'unknown',
    });
    expect(s.runs).toEqual([]);
    // Bravo's own approval stands, and alpha's still fires after every attempt of bravo's.
    expect(await inBravo((tx) => readStandingApproval(tx, bravo.activationId))).toMatchObject({
      id: bravo.approvalId,
      revoked: false,
    });
    expect(await w.inAlpha((tx) => readStandingApproval(tx, activation.id))).toMatchObject({
      id: approval.id,
      revoked: false,
    });
    expect(await w.inAlpha((tx) => readStandingApproval(tx, bravo.activationId))).toBeNull();
    const fired = await f.dispatch(occurrence.id, s.start);
    expect(fired.kind === 'dispatched' && fired.dispatch.outcome).toBe('started');
  });
});
