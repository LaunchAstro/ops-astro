// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's commands through the real API route (U36): a person adopts an exact
// released version on an activation (`activation.adopt`), rolls back to a
// version it adopted before (`activation.roll_back`), revokes a standing
// approval (`approval.revoke`) and turns an automation off
// (`activation.turn_off`), each `automation:manage`, and Settings ▸ Workflow
// triggers shows the approval that stands. Who may do each is in
// `c52a-authority.test.ts`; two adoptions racing in `c52a-command-races`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimOccurrence, dispatchOccurrence } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { ActivationView } from '../../packages/core-wire/src/index.ts';
import { createRegistryWorld, detail, type RegistryWorld } from './registry-world.ts';
import { starter } from './firing.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C52-A standing approval commands', () => {
  let w: RegistryWorld;

  beforeAll(async () => {
    w = await createRegistryWorld('c52ac');
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  const shown = async (activationId: string): Promise<ActivationView | undefined> =>
    (await w.registry(w.admin)).definitions
      .flatMap((one) => one.activations)
      .find((one) => one.id === activationId);

  /** A definition with versions 1 and 2 in `modes`, and an activation pinned to 1. */
  const twoVersions = async (modes: readonly string[] = ['manual', 'scheduled']) => {
    const { definitionId, versionId: first } = await w.define(modes);
    const on = await w.activate(first);
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    const next = await w.release({ definitionId, modes });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    return {
      definitionId,
      first,
      second: String(detail(next)['versionId']),
      activationId: String(detail(on)['activationId']),
    };
  };

  const adopt = async (activationId: string, versionId: string, expectedRevision: unknown) =>
    await w.as(w.admin, 'activation.adopt', { activationId, versionId, expectedRevision });

  /** Versions 1 then 2 adopted, each by the admin: the activation at revision 3. */
  const adoptedBoth = async () => {
    const pair = await twoVersions();
    const one = await adopt(pair.activationId, pair.first, 1);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    const two = await adopt(pair.activationId, pair.second, 2);
    expect(two.status, JSON.stringify(two.body)).toBe(200);
    return {
      ...pair,
      firstApproval: String(detail(one)['approvalId']),
      secondApproval: String(detail(two)['approvalId']),
    };
  };

  let hour = 0;
  const fireOnce = async (activationId: string): Promise<number> => {
    const counting = starter();
    const { db, business } = w.controls.fixture;
    await db.app.withBusiness(business, async (tx) => {
      const claim = await claimOccurrence(tx, activationId, {
        dueAt: new Date(Date.UTC(2026, 10, 2, (hour += 1))),
      });
      if (claim.kind === 'claimed' || claim.kind === 'replayed') {
        await dispatchOccurrence(tx, claim.occurrence.id, counting.start);
      }
    });
    return counting.runs.length;
  };

  it('C52-A adopt exact version: an activation pinning version 1 adopts version 2, which stands approved and fires', async () => {
    const { second, activationId } = await twoVersions();
    const before = await shown(activationId);
    expect([before?.versionNumber, before?.approval]).toStrictEqual([1, null]);
    expect(await fireOnce(activationId)).toBe(0);

    const adopted = await adopt(activationId, second, before?.revision);
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    const approvalId = String(detail(adopted)['approvalId']);
    const after = await shown(activationId);
    expect([after?.versionId, after?.versionNumber, after?.revision]).toStrictEqual([
      second,
      2,
      (before?.revision ?? 0) + 1,
    ]);
    expect(after?.approval).toStrictEqual({
      id: approvalId,
      versionId: second,
      act: 'adopted',
      decidedBy: w.admin.actorId,
      revoked: false,
    });
    expect(await fireOnce(activationId)).toBe(1);
  });

  it('C52-A adopt exact version: a stale revision, another definition’s version, unknown rows and malformed fields adopt nothing', async () => {
    const { activationId, second } = await twoVersions();
    const other = await w.define(['manual', 'scheduled']);
    const before = [...(await w.changes()), await w.rows('standing_approvals')];
    const at = (await shown(activationId))?.revision;

    const stale = await adopt(activationId, second, (at ?? 0) + 5);
    expect([stale.status, stale.body['code'], stale.body['names']]).toStrictEqual([
      409,
      'VERSION_STALE',
      [`revision=${String(at)}`],
    ]);
    const foreign = await adopt(activationId, other.versionId, at);
    expect([foreign.status, foreign.body['code']]).toStrictEqual([409, 'TRANSITION_NOT_PERMITTED']);
    for (const [answer, field] of [
      [await adopt(activationId, randomUUID(), at), 'versionId'],
      [await adopt(randomUUID(), second, at), 'activationId'],
      [await adopt('not-an-id', second, at), 'activationId'],
    ] as const) {
      expect([answer.status, answer.body['code'], answer.body['names']]).toStrictEqual([
        404,
        'NOT_FOUND',
        [field],
      ]);
    }
    for (const revision of [undefined, 0, 1.5, '1', null, -1]) {
      // eslint-disable-next-line no-await-in-loop -- one value at a time
      const bad = await adopt(activationId, second, revision);
      expect([bad.status, bad.body['code'], bad.body['names']], String(revision)).toStrictEqual([
        422,
        'FIELD_VALUE_INVALID',
        ['expectedRevision'],
      ]);
      expect(JSON.stringify(bad.body)).not.toContain(w.canary);
    }
    expect([...(await w.changes()), await w.rows('standing_approvals')]).toStrictEqual(before);
    expect((await shown(activationId))?.approval).toBeNull();
  });

  it('C52-A adopt exact version: a version that does not permit the activation’s mode is refused', async () => {
    const { definitionId, activationId } = await twoVersions(['manual', 'scheduled']);
    const manualOnly = await w.release({ definitionId, modes: ['manual'] });
    expect(manualOnly.status).toBe(200);
    const at = (await shown(activationId))?.revision;
    const answer = await adopt(activationId, String(detail(manualOnly)['versionId']), at);
    expect([answer.status, answer.body['code']]).toStrictEqual([409, 'TRANSITION_NOT_PERMITTED']);
    expect((await shown(activationId))?.versionNumber).toBe(1);
  });

  it('C52-A rollback keeps history: rolling back pins the version adopted before with a new approval, and every adoption and version 2 stay', async () => {
    const { first, second, activationId } = await adoptedBoth();
    const back = await w.as(w.admin, 'activation.roll_back', { activationId, expectedRevision: 3 });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const after = await shown(activationId);
    expect([after?.versionId, after?.versionNumber, after?.revision]).toStrictEqual([first, 1, 4]);
    expect(after?.approval).toMatchObject({
      id: String(detail(back)['approvalId']),
      versionId: first,
      act: 'rolled_back',
      decidedBy: w.admin.actorId,
      revoked: false,
    });
    const history = await w.controls.fixture.db.admin.execute<{
      readonly version_id: string;
      readonly act: string;
    }>(
      'select version_id, act from public.standing_approvals where activation_id = $1 order by sequence',
      [activationId],
    );
    expect(history.map((one) => [one.version_id, one.act])).toStrictEqual([
      [first, 'adopted'],
      [second, 'adopted'],
      [first, 'rolled_back'],
    ]);
    const versions = (await w.registry(w.admin)).definitions
      .find((one) => one.activations.some((a) => a.id === activationId))
      ?.versions.map((one) => one.number);
    expect(versions).toStrictEqual([1, 2]);
    expect(await fireOnce(activationId)).toBe(1);

    const stale = await w.as(w.admin, 'activation.roll_back', {
      activationId,
      expectedRevision: 3,
    });
    expect([stale.status, stale.body['code']]).toStrictEqual([409, 'VERSION_STALE']);
  });

  it('C52-A nothing to roll back to: a version never adopted, or adopted and revoked, is no rollback target, and nothing changes', async () => {
    // Version 1 was pinned by a settings change, never adopted.
    const never = await twoVersions();
    expect((await adopt(never.activationId, never.second, 1)).status).toBe(200);
    // Version 1 adopted, then that adoption revoked, then version 2 adopted.
    const revoked = await adoptedBoth();
    const revoke = await w.as(w.admin, 'approval.revoke', { approvalId: revoked.firstApproval });
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
    const before = [...(await w.changes()), await w.rows('standing_approvals')];
    for (const [activationId, expectedRevision] of [
      [never.activationId, 2],
      [revoked.activationId, 3],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one activation at a time
      const answer = await w.as(w.admin, 'activation.roll_back', {
        activationId,
        expectedRevision,
      });
      expect([answer.status, answer.body['code'], answer.body['names']]).toStrictEqual([
        409,
        'TRANSITION_NOT_PERMITTED',
        ['versionId'],
      ]);
    }
    expect([...(await w.changes()), await w.rows('standing_approvals')]).toStrictEqual(before);
    expect((await shown(never.activationId))?.versionNumber).toBe(2);
  });

  it('C52-A revoke apart from rollback: revoking leaves the pin, a repeat is refused, and a rollback does not revoke', async () => {
    const { first, second, activationId, secondApproval } = await adoptedBoth();
    const operationId = randomUUID();
    const revoke = await w.as(w.admin, 'approval.revoke', {
      approvalId: secondApproval,
      operationId,
    });
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
    const revoked = await shown(activationId);
    expect([revoked?.versionId, revoked?.approval?.id, revoked?.approval?.revoked]).toStrictEqual([
      second,
      secondApproval,
      true,
    ]);
    expect(await fireOnce(activationId)).toBe(0);
    const revocations = await w.rows('standing_approval_revocations');
    // The same attempt again is replayed; a new attempt is refused.
    const replay = await w.as(w.admin, 'approval.revoke', {
      approvalId: secondApproval,
      operationId,
    });
    expect([replay.status, detail(replay)]).toStrictEqual([200, detail(revoke)]);
    const twice = await w.as(w.admin, 'approval.revoke', { approvalId: secondApproval });
    expect([twice.status, twice.body['code']]).toStrictEqual([409, 'TRANSITION_NOT_PERMITTED']);
    expect(await w.rows('standing_approval_revocations')).toBe(revocations);

    const back = await w.as(w.admin, 'activation.roll_back', {
      activationId,
      expectedRevision: revoked?.revision,
    });
    expect(back.status).toBe(200);
    const after = await shown(activationId);
    expect([after?.versionId, after?.approval?.act, after?.approval?.revoked]).toStrictEqual([
      first,
      'rolled_back',
      false,
    ]);
    const unknown = await w.as(w.admin, 'approval.revoke', { approvalId: randomUUID() });
    expect([unknown.status, unknown.body['code']]).toStrictEqual([404, 'NOT_FOUND']);
  });

  it('C52-A owner check: turning an automation off, its next scheduled run does not fire and the change is in its history', async () => {
    const { second, activationId } = await twoVersions();
    expect((await adopt(activationId, second, 1)).status).toBe(200);
    expect(await fireOnce(activationId)).toBe(1);

    const off = await w.as(w.admin, 'activation.turn_off', { activationId, expectedRevision: 2 });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const after = await shown(activationId);
    expect([after?.enabled, after?.revision, after?.approval]).toStrictEqual([false, 3, null]);
    expect(await fireOnce(activationId)).toBe(0);
    const history = await w.controls.fixture.db.admin.execute<{ readonly actor_id: string }>(
      `select actor_id from public.audit_events
        where command = 'activation.turn_off' and outcome = 'applied' and subject_record_id = $1`,
      [activationId],
    );
    expect(history.map((one) => one.actor_id)).toStrictEqual([w.admin.actorId]);
    const [row] = await w.controls.fixture.db.admin.execute<{ readonly by: string }>(
      'select changed_by_actor_id as by from public.activations where id = $1 and not enabled',
      [activationId],
    );
    expect(row?.by).toBe(w.admin.actorId);

    const again = await w.as(w.admin, 'activation.turn_off', { activationId, expectedRevision: 3 });
    expect([again.status, again.body['code']]).toStrictEqual([409, 'TRANSITION_NOT_PERMITTED']);
    const stale = await w.as(w.admin, 'activation.turn_off', { activationId, expectedRevision: 2 });
    expect([stale.status, stale.body['code']]).toStrictEqual([409, 'VERSION_STALE']);
    expect((await shown(activationId))?.revision).toBe(3);
  });
});
