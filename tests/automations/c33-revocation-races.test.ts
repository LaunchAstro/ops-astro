// SPDX-License-Identifier: AGPL-3.0-only
//
// C33 criterion 5 under revocation, through the real API route, each request
// on a connection of its own (`RegistryWorld.asWide`). A write and a
// revocation of the grant that admitted it: the write's grants are held for
// share before any automation row, so a revocation that comes second waits
// for the write, and one committed after admission but before the hold
// refuses it. Never a write applied after its grant was revoked (Sol
// PRV-oa-977-R1 F1 and the security re-bind's L1).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Answer } from '../api/fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { grantOf, revokedMeanwhile, serialised, waitingOn } from './race-hold.ts';
import { createRegistryWorld, detail, RELEASE, type RegistryWorld } from './registry-world.ts';

const serverUrl = databaseUrlFromEnvironment();

/**
 * The other order: a revocation committed after the write was admitted and
 * before its hold. The owner locks the caller's fresh grant, the write waits
 * on it in its hold, the owner revokes it and commits; the write's answer.
 */
async function revokedBeforeHold(
  w: RegistryWorld,
  collection: string,
  send: () => Promise<Answer>,
): Promise<Answer> {
  const grantId = await w.controls.fixture.db.app.withBusiness(
    w.alpha,
    async (tx) => await grantTo(tx, w.plain, 'manage', undefined, false, collection),
  );
  const holder = connectAsAdmin(w.holderUrl(), { source: 'harness' });
  const sent: Promise<Answer>[] = [];
  try {
    await holder.transaction(async (execute) => {
      await execute('select 1 from public.grants where id = $1 for update', [grantId]);
      sent.push(send());
      await waitingOn(execute, 1);
      await execute(
        'update public.grants set revoked_at = greatest(now(), granted_at) where id = $1',
        [grantId],
      );
    });
    const [write] = await Promise.all(sent);
    return write as Answer;
  } finally {
    await holder.close();
  }
}

// eslint-disable-next-line max-lines-per-function -- one world, the revocation races that share it
describe.skipIf(serverUrl === undefined)('C33 revocation races', () => {
  let w: RegistryWorld;

  beforeAll(async () => {
    w = await createRegistryWorld('c33v');
    // Each wide connection opened before the race: one opened while the lock is polled can stall.
    await Promise.all(
      [1, 2, 3, 4].map(async () => await w.asWide(w.admin, 'automation.registry', {})),
    );
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('C33 revoked while waiting: activation.change never applies after its settings:manage grant is revoked', async () => {
    const { versionId } = await w.define(['manual', 'scheduled']);
    const activationId = String(detail(await w.activate(versionId))['activationId']);
    const raced = await revokedMeanwhile(
      w,
      async (execute) =>
        await execute('select 1 from public.activations where id = $1 for update', [activationId]),
      async () =>
        await w.asWide(w.settingsOnly, 'activation.change', {
          activationId,
          versionId,
          mode: 'manual',
          enabled: true,
          expectedRevision: 1,
        }),
      await grantOf(w, w.settingsOnly, 'settings'),
    );
    const changed = (await w.registry(w.admin)).definitions
      .flatMap((one) => one.activations)
      .find((one) => one.id === activationId);
    expect(serialised(raced), JSON.stringify([raced.write.body, raced.revoke.body])).toStrictEqual(
      raced.revokedFirst ? ['revoked first', 'SCOPE_NOT_GRANTED'] : ['write first', 200, 200],
    );
    expect([changed?.mode, changed?.revision]).toStrictEqual(
      raced.revokedFirst ? ['scheduled', 1] : ['manual', 2],
    );
  }, 60_000);

  it('C33 revoked while waiting: definition.release never applies after its automation:manage grant is revoked', async () => {
    const { definitionId } = await w.define(['manual']);
    const raced = await revokedMeanwhile(
      w,
      async (execute) =>
        await execute(
          `insert into public.definition_versions
             (business_id, id, definition_id, number, content_digest, content_size, inputs,
              operations, modes, released_by_actor_id)
           values ($1, gen_random_uuid(), $2, 2, repeat('e', 64), 1, '[]', '[]', '{manual}', $3)`,
          [w.alpha, definitionId, w.admin.actorId],
        ),
      async () =>
        await w.asWide(w.automationOnly, 'definition.release', {
          ...RELEASE,
          definitionId,
          modes: ['manual'],
        }),
      await grantOf(w, w.automationOnly, 'automation'),
    );
    const shown = (await w.registry(w.admin)).definitions.find((one) => one.id === definitionId);
    expect(serialised(raced), JSON.stringify([raced.write.body, raced.revoke.body])).toStrictEqual(
      raced.revokedFirst ? ['revoked first', 'SCOPE_NOT_GRANTED'] : ['write first', 200, 200],
    );
    expect(shown?.versions.map((one) => one.number)).toStrictEqual(
      raced.revokedFirst ? [1, 2] : [1, 2, 3],
    );
  }, 60_000);
  it('C33 revoked before the hold: activation.change admitted before a revocation is refused once its grants are held', async () => {
    const { versionId } = await w.define(['manual', 'scheduled']);
    const activationId = String(detail(await w.activate(versionId))['activationId']);
    const write = await revokedBeforeHold(
      w,
      'settings',
      async () =>
        await w.asWide(w.plain, 'activation.change', {
          activationId,
          versionId,
          mode: 'manual',
          enabled: true,
          expectedRevision: 1,
        }),
    );
    expect([write.status, write.body['code']], JSON.stringify(write.body)).toStrictEqual([
      403,
      'SCOPE_NOT_GRANTED',
    ]);
    const kept = (await w.registry(w.admin)).definitions
      .flatMap((one) => one.activations)
      .find((one) => one.id === activationId);
    expect([kept?.mode, kept?.revision]).toStrictEqual(['scheduled', 1]);
  }, 60_000);

  it('C33 revoked before the hold: definition.release admitted before a revocation is refused once its grants are held', async () => {
    const { definitionId } = await w.define(['manual']);
    const write = await revokedBeforeHold(
      w,
      'automation',
      async () =>
        await w.asWide(w.plain, 'definition.release', {
          ...RELEASE,
          definitionId,
          modes: ['manual'],
        }),
    );
    expect([write.status, write.body['code']], JSON.stringify(write.body)).toStrictEqual([
      403,
      'SCOPE_NOT_GRANTED',
    ]);
    const shown = (await w.registry(w.admin)).definitions.find((one) => one.id === definitionId);
    expect(shown?.versions.map((one) => one.number)).toStrictEqual([1]);
    expect(
      await w.controls.count(
        `select count(*) as n from public.audit_events
          where actor_id = $1 and outcome = 'applied'
            and command in ('activation.change', 'definition.release')`,
        [w.plain.actorId],
      ),
    ).toBe(0);
  }, 60_000);
});
