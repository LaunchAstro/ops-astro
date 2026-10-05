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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Answer } from '../api/fixture.ts';
import { LOCK_WAITS } from './firing.ts';
import { createRegistryWorld, detail, type RegistryWorld } from './registry-world.ts';

const serverUrl = databaseUrlFromEnvironment();

type Execute = (sql: string, params: readonly unknown[]) => Promise<readonly unknown[]>;

/** Polls until `count` statements of this database wait on a lock. */
async function waitingOn(execute: Execute, count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling until both wait
    const [row] = (await execute(LOCK_WAITS, [])) as readonly { readonly n: string }[];
    if (Number(row?.n) >= count) return;
    if (Date.now() > deadline) throw new Error(`only ${String(row?.n)} of ${count} ever waited`);
    // eslint-disable-next-line no-await-in-loop -- as above
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

/** Both requests sent while the owner holds the activation, and their answers once it lets go. */
async function overlapped(
  w: RegistryWorld,
  activationId: string,
  send: () => Promise<Answer>,
): Promise<readonly Answer[]> {
  const holder = connectAsAdmin(w.holderUrl(), { source: 'harness' });
  const sent: Promise<Answer>[] = [];
  try {
    await holder.transaction(async (execute) => {
      await execute('select 1 from public.activations where id = $1 for update', [activationId]);
      sent.push(send(), send());
      await waitingOn(execute, 2);
    });
    return await Promise.all(sent);
  } finally {
    await holder.close();
  }
}

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
      activationId,
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
      activationId,
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
});
