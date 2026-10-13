// SPDX-License-Identifier: AGPL-3.0-only
//
// Budget stops on a client's task, answered by people who hold `decide` across
// that client only. A harness, not a suite: nothing here runs on its own.
//
// No client task reaches a model call through the broker yet (C60), so each
// stop is made on an internal task and then moved under its client by the
// admin connection. The plan approver's business-wide `billing:decide` is
// revoked once per file, so the plan-approver rule does not answer for every
// other holder; their `gate:decide` stays, since they approve the plans.

import { randomUUID } from 'node:crypto';
import { beforeAll } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { clientHere } from '../reads/client-rows.ts';
import { noDatabase, s } from './broker-world.ts';

/** Revokes the plan approver's business-wide `billing:decide`, once per file. */
export function usePlanApproverWithoutBilling(): void {
  beforeAll(async () => {
    if (noDatabase) return;
    const grants = await s.db.admin.execute<{ readonly id: string }>(
      `select id from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'billing' and action = 'decide' and scope_kind = 'business'
          and revoked_at is null`,
      [s.business, s.decider.personId],
    );
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const grant of grants) {
        // oxlint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
        await revokeGrant(tx, grant.id);
      }
    });
  }, 60_000);
}

/** Puts an internal task under `clientId`, a client of this business. */
export async function underClient(taskId: string, clientId: string): Promise<void> {
  await clientHere(s.db.admin, s.business, clientId);
  await s.db.admin.execute(
    // The client link is the task's `client` field, which the record store projects to `uuid_7`.
    `update public.records set data = data || jsonb_build_object('client', $3::text)
      where business_id = $1 and id = $2::uuid`,
    [s.business, taskId, clientId],
  );
}

/** A grant of `decide` on the collection across one client, its id handed back. */
export async function decideAcross(
  member: Member,
  clientId: string,
  collection: 'billing' | 'gate',
): Promise<string> {
  return await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await grantTo(tx, member, 'decide', { kind: 'party', id: clientId }, false, collection),
  );
}

/** A new member holding `read`, `billing:decide` and `gate:decide` across one client only. */
export async function clientWideDecider(clientId: string): Promise<Member> {
  const member = await enrol(s.db.app, s.business, `client-decider-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, member, 'read', { kind: 'party', id: clientId });
  });
  await decideAcross(member, clientId, 'billing');
  await decideAcross(member, clientId, 'gate');
  return member;
}

/** The backend id of the connection running `execute`. */
export async function backendOf(
  execute: (sql: string, params?: readonly unknown[]) => Promise<readonly unknown[]>,
): Promise<number> {
  const [row] = (await execute('select pg_backend_pid() as pid')) as { pid: number }[];
  if (row === undefined) throw new Error('backendOf: no backend id');
  return row.pid;
}

/** Waits until some backend is blocked on `holder`, so a race is staged, not hoped for. */
export async function someoneBlockedBy(holder: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time until the wait shows
    const waiting = await s.db.admin.execute(
      'select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
      [holder],
    );
    if (waiting.length > 0) return;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`nothing blocked on backend ${holder} within 30 s`);
}
