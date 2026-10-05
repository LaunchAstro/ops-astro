// SPDX-License-Identifier: AGPL-3.0-only
//
// Who may approve, and when (C52-A), through the real API route, each request
// on a connection of its own (`RegistryWorld.asWide`), the owner holding the
// activation's row until the request waits on it.
//
// Each of the four writes and a revocation of the automation:manage grant
// that admitted it: the write's grants are held for share before any
// automation row, so a revocation that comes second waits for the write, and
// one that came first refuses it. Never a change applied after its grant was
// revoked (as C33 criterion 5). A grant that runs out while the write waits
// on the activation is asked again after the wait, so it refuses the write
// too. And only an automation that is on is approved: one that is off adopts
// and rolls back nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import type { Answer } from '../api/fixture.ts';
import {
  grantOf,
  pinnedFirstOf,
  revokedMeanwhile,
  serialised,
  heldWhile,
  type Execute,
} from './race-hold.ts';
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

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C52-A approval authority', () => {
  let w: RegistryWorld;

  beforeAll(async () => {
    w = await createRegistryWorld('c52v');
    // Each wide connection opened before the race: one opened while the lock is polled can stall.
    await Promise.all(
      [1, 2, 3, 4].map(async () => await w.asWide(w.admin, 'automation.registry', {})),
    );
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  const pinnedFirst = async () => await pinnedFirstOf(w);

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

  const expiringWhile = async (
    activationId: string,
    name: string,
    body: Record<string, unknown>,
  ): Promise<Answer> => {
    const grantId = await w.controls.fixture.db.app.withBusiness(
      w.alpha,
      async (tx) => await grantTo(tx, w.plain, 'manage', undefined, false, 'automation'),
    );
    await w.controls.fixture.db.admin.execute(
      `update public.grants set expires_at = clock_timestamp() + interval '3 seconds' where id = $1`,
      [grantId],
    );
    return await heldWhile(
      w,
      activationId,
      async () => await w.asWide(w.plain, name, body),
      async (execute) => {
        const deadline = Date.now() + 10_000;
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- until the grant has run out
          const [row] = (await execute(
            'select clock_timestamp() > expires_at as past from public.grants where id = $1',
            [grantId],
          )) as readonly { readonly past: boolean }[];
          if (row?.past === true) return;
          if (Date.now() > deadline) throw new Error('the grant never ran out');
          // eslint-disable-next-line no-await-in-loop -- as above
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
        }
      },
    );
  };

  /** Four activations: one to adopt on, one adopted twice to roll back, one to turn off, one approval to revoke. */
  const expiryCases = async () => {
    const adoptCase = await pinnedFirst();
    const backCase = await pinnedFirst();
    const firstOfBack = (await shownOf(backCase.activationId))?.versionId;
    for (const [versionId, expectedRevision] of [
      [firstOfBack, 1],
      [backCase.second, 2],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one adoption after another
      const one = await w.as(w.admin, 'activation.adopt', {
        activationId: backCase.activationId,
        versionId,
        expectedRevision,
      });
      expect(one.status).toBe(200);
    }
    const offCase = await pinnedFirst();
    const revokeCase = await pinnedFirst();
    const adopted = await w.as(w.admin, 'activation.adopt', {
      activationId: revokeCase.activationId,
      versionId: (await shownOf(revokeCase.activationId))?.versionId,
      expectedRevision: 1,
    });
    const approvalId = String(detail(adopted)['approvalId']);
    return { adoptCase, backCase, offCase, revokeCase, approvalId };
  };

  it('C52-A expired while waiting: no change applies after its automation:manage grant ran out during the lock wait', async () => {
    const { adoptCase, backCase, offCase, revokeCase, approvalId } = await expiryCases();
    const answers = [
      await expiringWhile(adoptCase.activationId, 'activation.adopt', {
        activationId: adoptCase.activationId,
        versionId: adoptCase.second,
        expectedRevision: 1,
      }),
      await expiringWhile(backCase.activationId, 'activation.roll_back', {
        activationId: backCase.activationId,
        expectedRevision: 3,
      }),
      await expiringWhile(offCase.activationId, 'activation.turn_off', {
        activationId: offCase.activationId,
        expectedRevision: 1,
      }),
      await expiringWhile(revokeCase.activationId, 'approval.revoke', { approvalId }),
    ];
    expect(
      answers.map((one) => [one.status, one.body['code']]),
      JSON.stringify(answers.map((one) => one.body)),
    ).toStrictEqual(Array.from({ length: 4 }, () => [403, 'SCOPE_NOT_GRANTED']));
    const shown = await Promise.all(
      [adoptCase, backCase, offCase, revokeCase].map(
        async (one) => await shownOf(one.activationId),
      ),
    );
    expect(
      shown.map((one) => [one?.revision, one?.enabled, one?.approval?.revoked ?? null]),
    ).toStrictEqual([
      [1, true, null],
      [3, true, false],
      [1, true, null],
      [2, true, false],
    ]);
  }, 120_000);

  it('C52-A approves only what is on: an automation that is off adopts and rolls back nothing, and names no approval', async () => {
    const { activationId, second } = await pinnedFirst();
    const first = (await shownOf(activationId))?.versionId;
    const adopt = async (versionId: string | undefined, expectedRevision: number) =>
      await w.as(w.admin, 'activation.adopt', { activationId, versionId, expectedRevision });
    expect((await adopt(first, 1)).status).toBe(200);
    expect((await adopt(second, 2)).status).toBe(200);
    const off = await w.as(w.admin, 'activation.turn_off', { activationId, expectedRevision: 3 });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const approvals = await w.rows('standing_approvals');
    const back = await w.as(w.admin, 'activation.roll_back', { activationId, expectedRevision: 4 });
    const again = await adopt(second, 4);
    expect(
      [back, again].map((one) => [one.status, one.body['code'], one.body['names']]),
    ).toStrictEqual([
      [409, 'TRANSITION_NOT_PERMITTED', ['enabled=false']],
      [409, 'TRANSITION_NOT_PERMITTED', ['enabled=false']],
    ]);
    expect(await w.rows('standing_approvals')).toBe(approvals);
    const shown = await shownOf(activationId);
    expect([shown?.enabled, shown?.revision, shown?.approval]).toStrictEqual([false, 4, null]);
  });
});
