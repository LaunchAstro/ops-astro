// SPDX-License-Identifier: AGPL-3.0-only
//
// C33's two races through the real API route, each request on a connection of
// its own (`RegistryWorld.asWide`; the fixture's pool holds one, which would
// serialise them first). The owner holds a row in a transaction of its own
// until both requests wait on it, so they overlap every time rather than by
// luck, then lets them go together.
//
// A release racing another computes the same next number; the database keeps
// one and the command asks again in its transaction, so both are released, on
// distinct numbers. Two changes sent at one revision apply once: the update
// compares the revision itself, so the second finds it moved and changes
// nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { overlapped } from './race-hold.ts';
import { createRegistryWorld, detail, RELEASE, type RegistryWorld } from './registry-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the two races that share it
describe.skipIf(serverUrl === undefined)('C33 command races', () => {
  let w: RegistryWorld;

  beforeAll(async () => {
    w = await createRegistryWorld('c33r');
    // Each wide connection opened before the race: one opened while the lock is polled can stall.
    await Promise.all(
      [1, 2, 3, 4].map(async () => await w.asWide(w.admin, 'automation.registry', {})),
    );
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('C33 racing release asked again: two releases at once on one definition are both released, on distinct next numbers', async () => {
    const { definitionId } = await w.define(['manual']);
    const answers = await overlapped(
      w,
      // The owner's own release of number 2, uncommitted: both requests compute
      // 2 as well and wait on its uniqueness, then find it taken together.
      async (execute) =>
        await execute(
          `insert into public.definition_versions
             (business_id, id, definition_id, number, content_digest, content_size, inputs,
              operations, modes, released_by_actor_id)
           values ($1, gen_random_uuid(), $2, 2, repeat('e', 64), 1, '[]', '[]', '{manual}', $3)`,
          [w.alpha, definitionId, w.admin.actorId],
        ),
      async () =>
        await w.asWide(w.admin, 'definition.release', {
          ...RELEASE,
          definitionId,
          modes: ['manual'],
        }),
    );
    expect(
      answers.map((answer) => answer.status),
      JSON.stringify(answers.map((answer) => answer.body)),
    ).toStrictEqual([200, 200]);
    expect(answers.map((answer) => detail(answer)['number']).toSorted()).toStrictEqual([3, 4]);
    const shown = (await w.registry(w.admin)).definitions.find((one) => one.id === definitionId);
    expect(shown?.versions.map((one) => one.number)).toStrictEqual([1, 2, 3, 4]);
  }, 60_000);

  it('C33 one change per revision: two changes sent at one revision apply once, the other refused VERSION_STALE', async () => {
    const { versionId } = await w.define(['manual', 'scheduled']);
    const on = await w.activate(versionId);
    const activationId = String(detail(on)['activationId']);
    const answers = await overlapped(
      w,
      async (execute) =>
        await execute('select 1 from public.activations where id = $1 for update', [activationId]),
      async () =>
        await w.asWide(w.admin, 'activation.change', {
          activationId,
          versionId,
          mode: 'manual',
          enabled: true,
          expectedRevision: 1,
        }),
    );
    expect(
      answers.map((answer) => [answer.status, answer.body['code']]).toSorted(),
      JSON.stringify(answers.map((answer) => answer.body)),
    ).toStrictEqual([
      [200, undefined],
      [409, 'VERSION_STALE'],
    ]);
    const changed = (await w.registry(w.admin)).definitions
      .flatMap((one) => one.activations)
      .find((one) => one.id === activationId);
    expect([changed?.mode, changed?.revision]).toStrictEqual(['manual', 2]);
    expect(
      await w.controls.count(
        `select count(*) as n from public.audit_events
          where command = 'activation.change' and outcome = 'applied' and actor_id = $1`,
        [w.admin.actorId],
      ),
    ).toBe(2);
  }, 60_000);
});
