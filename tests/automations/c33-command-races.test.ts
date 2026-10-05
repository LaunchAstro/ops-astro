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
//
// A write and a revocation of the grant that admitted it: the write's grants
// are held for share before any automation row, so a revocation that comes
// second waits for the write, and one that came first refuses it. Never a
// write applied after its grant was revoked (C33 criterion 5).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Answer } from '../api/fixture.ts';
import type { Member } from '../commands/fixture.ts';
import { createRegistryWorld, detail, RELEASE, type RegistryWorld } from './registry-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const WAITING = `select count(*)::text as n from pg_stat_activity
  where datname = current_database() and wait_event_type = 'Lock'`;

type Execute = (sql: string, params: readonly unknown[]) => Promise<readonly unknown[]>;

/** Polls until `count` statements of this database wait on a lock. */
async function waitingOn(execute: Execute, count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling until both wait
    const [row] = (await execute(WAITING, [])) as readonly { readonly n: string }[];
    if (Number(row?.n) >= count) return;
    if (Date.now() > deadline) throw new Error(`only ${String(row?.n)} of ${count} ever waited`);
    // eslint-disable-next-line no-await-in-loop -- as above
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

/** Both requests sent while the owner holds `hold`, and their answers once it lets go. */
async function overlapped(
  w: RegistryWorld,
  hold: (execute: Execute) => Promise<unknown>,
  send: () => Promise<Answer>,
): Promise<readonly Answer[]> {
  const holder = connectAsAdmin(w.holderUrl(), { source: 'harness' });
  const sent: Promise<Answer>[] = [];
  try {
    await holder.transaction(async (execute) => {
      await hold(execute);
      sent.push(send(), send());
      await waitingOn(execute, 2);
    });
    return await Promise.all(sent);
  } finally {
    await holder.close();
  }
}

/** The member's one live `manage` grant in `collection`, as the owner reads it. */
async function grantOf(w: RegistryWorld, member: Member, collection: string): Promise<string> {
  const rows = await w.controls.fixture.db.admin.execute<{ readonly id: string }>(
    `select id::text as id from public.grants
      where business_id = $1 and subject_kind = 'person' and subject_id = $2
        and collection = $3 and action = 'manage' and revoked_at is null`,
    [w.alpha, member.personId, collection],
  );
  expect(rows).toHaveLength(1);
  return String(rows[0]?.id);
}

/**
 * `send` while the owner holds `hold`; once it waits, the admin revokes the
 * grant that admitted it. Whether the revocation was answered while the write
 * still waited, then both answers once the owner lets go.
 */
async function revokedMeanwhile(
  w: RegistryWorld,
  hold: (execute: Execute) => Promise<unknown>,
  send: () => Promise<Answer>,
  grantId: string,
): Promise<{ readonly revokedFirst: boolean; readonly write: Answer; readonly revoke: Answer }> {
  const holder = connectAsAdmin(w.holderUrl(), { source: 'harness' });
  const sent: Promise<Answer>[] = [];
  let revokedFirst = false;
  try {
    await holder.transaction(async (execute) => {
      await hold(execute);
      sent.push(send());
      await waitingOn(execute, 1);
      let answered = false;
      const revoke = w.asWide(w.admin, 'grant.revoke', { grantId });
      sent.push(revoke);
      const settle = (): boolean => {
        answered = true;
        return answered;
      };
      void revoke.then(settle, settle);
      const deadline = Date.now() + 15_000;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- until it is answered or waits
        const [row] = (await execute(WAITING, [])) as readonly { readonly n: string }[];
        if (answered || Number(row?.n) >= 2) break;
        if (Date.now() > deadline) throw new Error('the revocation neither waited nor answered');
        // eslint-disable-next-line no-await-in-loop -- as above
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      revokedFirst = answered;
    });
    const [write, revoke] = await Promise.all(sent);
    return { revokedFirst, write: write as Answer, revoke: revoke as Answer };
  } finally {
    await holder.close();
  }
}

/** Never applied after its grant was revoked: refused if the revocation came first. */
const serialised = (raced: Awaited<ReturnType<typeof revokedMeanwhile>>): unknown =>
  raced.revokedFirst
    ? ['revoked first', raced.write.body['code']]
    : ['write first', raced.write.status, raced.revoke.status];

// eslint-disable-next-line max-lines-per-function -- one world, the races that share it
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
});
