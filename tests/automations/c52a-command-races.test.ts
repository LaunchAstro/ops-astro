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
// moved and changes nothing. A rollback picks its target only once it holds
// the activation, so a revocation of that target committed while it waited
// is seen and the rollback goes further back.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Answer } from '../api/fixture.ts';
import { heldWhile, overlapped, pinnedFirstOf, type Execute } from './race-hold.ts';
import { createRegistryWorld, detail, type RegistryWorld } from './registry-world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The owner's hold on one activation's row. */
const holding =
  (activationId: string) =>
  async (execute: Execute): Promise<unknown> =>
    await execute('select 1 from public.activations where id = $1 for update', [activationId]);

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

  const pinnedFirst = async () => await pinnedFirstOf(w);

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

  /** The activation as the owner's registry shows it. */
  const shownOf = async (activationId: string) =>
    (await w.registry(w.admin)).definitions
      .flatMap((one) => one.activations)
      .find((one) => one.id === activationId);

  it('C52-A rollback under the lock: a rollback waiting on a revocation of its target never approves that version again', async () => {
    const { activationId, second } = await pinnedFirst();
    const first = (await shownOf(activationId))?.versionId;
    const shown = await shownOf(activationId);
    const definitionId = String(
      (await w.registry(w.admin)).definitions.find((one) =>
        one.activations.some((a) => a.id === shown?.id),
      )?.id,
    );
    const third = String(
      detail(await w.release({ definitionId, modes: ['manual', 'scheduled'] }))['versionId'],
    );
    const adopt = async (versionId: string | undefined, expectedRevision: number) =>
      await w.as(w.admin, 'activation.adopt', { activationId, versionId, expectedRevision });
    expect((await adopt(first, 1)).status).toBe(200);
    const target = await adopt(second, 2);
    expect((await adopt(third, 3)).status).toBe(200);
    const back = await heldWhile(
      w,
      activationId,
      async () =>
        await w.asWide(w.admin, 'activation.roll_back', { activationId, expectedRevision: 4 }),
      async (execute) =>
        await execute(
          `insert into public.standing_approval_revocations
             (business_id, id, approval_id, revoked_by_actor_id)
           values ($1, gen_random_uuid(), $2, $3)`,
          [w.alpha, String(detail(target)['approvalId']), w.admin.actorId],
        ),
    );
    expect(
      [back.status, detail(back)['versionId'], detail(back)['act']],
      JSON.stringify(back.body),
    ).toStrictEqual([200, first, 'rolled_back']);
  }, 60_000);
});
