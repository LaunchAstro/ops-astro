// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A: what a run, a release and an edit may not change, and another business answering as unknown, against a
// real database (U36, #484). Firing is in `c52a-firing.test.ts`.

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
  turnOffActivation,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { firingOf, occurrenceOf, starter, type Firing } from './firing.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

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

  it('C52-A no silent skill change: runs and a newer release leave the pin and its approval; an edit leaves no approval standing', async () => {
    const { version, activation, approval } = await f.approved();
    const s = starter(w.worker);
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

  it('C52-A isolation: another business’s activation, approval and occurrence answer as unknown to the records', async () => {
    const { activation, approval } = await f.approved();
    const occurrence = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const s = starter(w.worker);
    const inBravo = async <T>(run: (tx: TenantQuery) => Promise<T>): Promise<T> =>
      await w.db.app.withBusiness(w.bravo, run);
    expect(
      await inBravo((tx) =>
        adoptVersion(tx, {
          activationId: activation.id,
          versionId: approval.versionId,
          expectedRevision: activation.revision,
          act: 'adopted',
          actorId: w.bravoAdmin.actorId,
        }),
      ),
    ).toEqual({ kind: 'unknown' });
    expect(
      await inBravo((tx) =>
        turnOffActivation(tx, {
          activationId: activation.id,
          expectedRevision: activation.revision,
          actorId: w.bravoAdmin.actorId,
        }),
      ),
    ).toEqual({ kind: 'unknown' });
    expect(
      await inBravo((tx) =>
        revokeApproval(tx, { approvalId: approval.id, actorId: w.bravoAdmin.actorId }),
      ),
    ).toBe('unknown');
    expect(await inBravo((tx) => readStandingApproval(tx, activation.id))).toBeNull();
    expect(await inBravo((tx) => listApprovals(tx, activation.id))).toEqual([]);
    expect(await inBravo((tx) => dispatchOccurrence(tx, occurrence.id, s.start))).toEqual({
      kind: 'unknown',
    });
    const bravoWorker = starter(w.bravoWorker);
    expect(await inBravo((tx) => dispatchOccurrence(tx, occurrence.id, bravoWorker.start))).toEqual(
      { kind: 'unknown' },
    );
    expect(s.runs).toEqual([]);
    expect(bravoWorker.runs).toEqual([]);
    expect(await w.inAlpha((tx) => readStandingApproval(tx, activation.id))).toMatchObject({
      id: approval.id,
      revoked: false,
    });
  });
});
