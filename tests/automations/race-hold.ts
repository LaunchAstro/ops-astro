// SPDX-License-Identifier: AGPL-3.0-only
//
// The automation races' harness (C33, C52-A), each request through the real API
// route on a connection of its own (`RegistryWorld.asWide`). The owner holds a
// row in a transaction of its own until the requests wait on it, so they
// overlap every time rather than by luck, then lets them go together. A
// revocation sent while a write waits shows whether the write's grants were
// held before its automation row: the revocation then waits for the write, or
// came first and refuses it.

import { expect } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/index.ts';
import type { Answer } from '../api/fixture.ts';
import type { Member } from '../commands/fixture.ts';
import { detail, type RegistryWorld } from './registry-world.ts';

export const WAITING = `select count(*)::text as n from pg_stat_activity
  where datname = current_database() and wait_event_type = 'Lock'`;

export type Execute = (sql: string, params: readonly unknown[]) => Promise<readonly unknown[]>;

/** Polls until `count` statements of this database wait on a lock. */
export async function waitingOn(execute: Execute, count: number): Promise<void> {
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
export async function overlapped(
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
export async function grantOf(
  w: RegistryWorld,
  member: Member,
  collection: string,
): Promise<string> {
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
export async function revokedMeanwhile(
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
export const serialised = (raced: Awaited<ReturnType<typeof revokedMeanwhile>>): unknown =>
  raced.revokedFirst
    ? ['revoked first', raced.write.body['code']]
    : ['write first', raced.write.status, raced.revoke.status];

/** An enabled scheduled activation pinning version 1 of two, at revision 1. */
export async function pinnedFirstOf(w: RegistryWorld): Promise<{
  readonly activationId: string;
  readonly second: string;
}> {
  const { definitionId, versionId } = await w.define(['manual', 'scheduled']);
  const on = await w.activate(versionId);
  const next = await w.release({ definitionId, modes: ['manual', 'scheduled'] });
  return {
    activationId: String(detail(on)['activationId']),
    second: String(detail(next)['versionId']),
  };
}

/**
 * `send` while the owner holds the activation's row, and `during` run in the
 * owner's transaction once `send` waits on it; the answer once the owner commits.
 */
export async function heldWhile(
  w: RegistryWorld,
  activationId: string,
  send: () => Promise<Answer>,
  during: (execute: Execute) => Promise<unknown>,
): Promise<Answer> {
  const holder = connectAsAdmin(w.holderUrl(), { source: 'harness' });
  const sent: Promise<Answer>[] = [];
  try {
    await holder.transaction(async (execute) => {
      await execute('select 1 from public.activations where id = $1 for update', [activationId]);
      sent.push(send());
      await waitingOn(execute, 1);
      await during(execute);
    });
    const [answer] = await Promise.all(sent);
    return answer as Answer;
  } finally {
    await holder.close();
  }
}
