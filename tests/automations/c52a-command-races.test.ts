// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's races through the real API route, each request on a connection of
// its own (`RegistryWorld.asWide`; the fixture's pool holds one, which would
// serialise them first). The owner holds the activation's row in a
// transaction of its own until both requests wait on it, so they overlap
// every time rather than by luck, then lets them go together.
//
// Two adoptions, or two turn-offs, sent at one revision apply once: each
// compares the revision under the activation's lock, so the second finds it
// moved and changes nothing.
//
// Each of the four writes and a revocation of the automation:manage grant
// that admitted it: the write's grants are held for share before any
// automation row, so a revocation that comes second waits for the write, and
// one that came first refuses it. Never a change applied after its grant was
// revoked (C52-A, as C33 criterion 5).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import type { Answer } from '../api/fixture.ts';
import { grantOf, overlapped, revokedMeanwhile, serialised, type Execute } from './race-hold.ts';
import { createRegistryWorld, detail, type RegistryWorld } from './registry-world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The owner's hold on one activation's row. */
const holding =
  (activationId: string) =>
  async (execute: Execute): Promise<unknown> =>
    await execute('select 1 from public.activations where id = $1 for update', [activationId]);

/** Never applied after its grant was revoked: refused if the revocation came first. */
const expectSerialised = (raced: Awaited<ReturnType<typeof revokedMeanwhile>>): void => {
  expect(serialised(raced), JSON.stringify([raced.write.body, raced.revoke.body])).toStrictEqual(
    raced.revokedFirst ? ['revoked first', 'SCOPE_NOT_GRANTED'] : ['write first', 200, 200],
  );
};

const outcomes = (answers: readonly Answer[]): readonly unknown[] =>
  answers.map((answer) => [answer.status, answer.body['code']]).toSorted();

// eslint-disable-next-line max-lines-per-function -- one world, the races that share it
describe.skipIf(serverUrl === undefined)('C52-A command races', () => {
  let w: RegistryWorld;

  beforeAll(async () => {
    w = await createRegistryWorld('c52r');
    // Each wide connection opened before the race: one opened while the lock is polled can stall.
    await Promise.all(
      [1, 2, 3, 4].map(async () => await w.asWide(w.admin, 'automation.registry', {})),
    );
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  /** An enabled scheduled activation pinning version 1 of two, at revision 1. */
  const pinnedFirst = async (): Promise<{
    readonly activationId: string;
    readonly second: string;
  }> => {
    const { definitionId, versionId } = await w.define(['manual', 'scheduled']);
    const on = await w.activate(versionId);
    const next = await w.release({ definitionId, modes: ['manual', 'scheduled'] });
    return {
      activationId: String(detail(on)['activationId']),
      second: String(detail(next)['versionId']),
    };
  };

  it('C52-A one adoption per revision: two adoptions sent at one revision apply once, the other refused VERSION_STALE', async () => {
    const { activationId, second } = await pinnedFirst();
    const approvals = await w.rows('standing_approvals');
    const answers = await overlapped(
      w,
      holding(activationId),
      async () =>
        await w.asWide(w.admin, 'activation.adopt', {
          activationId,
          versionId: second,
          expectedRevision: 1,
        }),
    );
    expect(outcomes(answers), JSON.stringify(answers.map((one) => one.body))).toStrictEqual([
      [200, undefined],
      [409, 'VERSION_STALE'],
    ]);
    expect(await w.rows('standing_approvals')).toBe(approvals + 1);
    const shown = (await w.registry(w.admin)).definitions
      .flatMap((one) => one.activations)
      .find((one) => one.id === activationId);
    expect([shown?.versionId, shown?.revision, shown?.approval?.act]).toStrictEqual([
      second,
      2,
      'adopted',
    ]);
  }, 60_000);

  it('C52-A one turn-off per revision: two turn-offs sent at one revision apply once, the other refused VERSION_STALE', async () => {
    const { activationId } = await pinnedFirst();
    const answers = await overlapped(
      w,
      holding(activationId),
      async () =>
        await w.asWide(w.admin, 'activation.turn_off', { activationId, expectedRevision: 1 }),
    );
    expect(outcomes(answers), JSON.stringify(answers.map((one) => one.body))).toStrictEqual([
      [200, undefined],
      [409, 'VERSION_STALE'],
    ]);
    expect(
      await w.controls.count(
        `select count(*) as n from public.audit_events
          where command = 'activation.turn_off' and outcome = 'applied' and subject_record_id = $1`,
        [activationId],
      ),
    ).toBe(1);
  }, 60_000);

  /** automationOnly's live `automation:manage` grant, issued again when a case revoked it. */
  const automationGrant = async (): Promise<string> => {
    const live = await w.controls.count(
      `select count(*) as n from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'automation' and action = 'manage' and revoked_at is null`,
      [w.alpha, w.automationOnly.personId],
    );
    if (live === 0) {
      await w.controls.fixture.db.app.withBusiness(w.alpha, async (tx) => {
        await grantTo(
          tx,
          w.automationOnly,
          'manage',
          { kind: 'business', id: null },
          false,
          'automation',
        );
      });
    }
    return await grantOf(w, w.automationOnly, 'automation');
  };

  /** The activation as the owner's registry shows it. */
  const shownOf = async (activationId: string) =>
    (await w.registry(w.admin)).definitions
      .flatMap((one) => one.activations)
      .find((one) => one.id === activationId);

  /** `name` sent by automationOnly while the activation is held, its grant revoked meanwhile. */
  const raceRevoke = async (activationId: string, name: string, body: Record<string, unknown>) =>
    await revokedMeanwhile(
      w,
      holding(activationId),
      async () => await w.asWide(w.automationOnly, name, body),
      await automationGrant(),
    );

  it('C52-A revoked while waiting: activation.adopt never applies after its automation:manage grant is revoked', async () => {
    const { activationId, second } = await pinnedFirst();
    const raced = await raceRevoke(activationId, 'activation.adopt', {
      activationId,
      versionId: second,
      expectedRevision: 1,
    });
    expectSerialised(raced);
    const shown = await shownOf(activationId);
    expect([shown?.versionId === second, shown?.revision]).toStrictEqual(
      raced.revokedFirst ? [false, 1] : [true, 2],
    );
  }, 60_000);

  it('C52-A revoked while waiting: activation.roll_back never applies after its automation:manage grant is revoked', async () => {
    const { activationId, second } = await pinnedFirst();
    const first = (await shownOf(activationId))?.versionId;
    const adopt = async (versionId: string | undefined, expectedRevision: number) =>
      await w.as(w.admin, 'activation.adopt', { activationId, versionId, expectedRevision });
    expect((await adopt(first, 1)).status).toBe(200);
    expect((await adopt(second, 2)).status).toBe(200);
    const raced = await raceRevoke(activationId, 'activation.roll_back', {
      activationId,
      expectedRevision: 3,
    });
    expectSerialised(raced);
    const shown = await shownOf(activationId);
    expect([shown?.versionId === first, shown?.revision]).toStrictEqual(
      raced.revokedFirst ? [false, 3] : [true, 4],
    );
  }, 60_000);

  it('C52-A revoked while waiting: activation.turn_off never applies after its automation:manage grant is revoked', async () => {
    const { activationId } = await pinnedFirst();
    const raced = await raceRevoke(activationId, 'activation.turn_off', {
      activationId,
      expectedRevision: 1,
    });
    expectSerialised(raced);
    const shown = await shownOf(activationId);
    expect([shown?.enabled, shown?.revision]).toStrictEqual(
      raced.revokedFirst ? [true, 1] : [false, 2],
    );
  }, 60_000);

  it('C52-A revoked while waiting: approval.revoke never applies after its automation:manage grant is revoked', async () => {
    const { activationId } = await pinnedFirst();
    const first = (await shownOf(activationId))?.versionId;
    const adopted = await w.as(w.admin, 'activation.adopt', {
      activationId,
      versionId: first,
      expectedRevision: 1,
    });
    const approvalId = String(detail(adopted)['approvalId']);
    const raced = await raceRevoke(activationId, 'approval.revoke', { approvalId });
    expectSerialised(raced);
    expect((await shownOf(activationId))?.approval?.revoked).toBe(!raced.revokedFirst);
  }, 60_000);
});
