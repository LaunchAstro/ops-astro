// SPDX-License-Identifier: AGPL-3.0-only
//
// A repeated agent operation is authorised under the rights held now.
//
// TRANSACTION-CONTRACT: "Authorise the replay's read under current rights
// before returning protected content", and the delegation credential is
// "stored by hash". Each case below makes the first call, changes the rights
// through their owning operation (or lets the delegation lapse), then repeats
// the identical operation id with the same agent bearer.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { agentWorld, codeOf, detailOf, type AgentWorld } from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('an agent replay under current rights', () => {
  let world: AgentWorld;

  beforeAll(async () => {
    world = await agentWorld('r', 'agent-replay-auth');
  }, 90_000);

  afterAll(async () => {
    await world?.drop();
  });

  const readTwice = async (
    change: (
      picked: Awaited<ReturnType<AgentWorld['pickUp']>>,
      grants: Record<string, string>,
    ) => Promise<void>,
    expected: string,
  ): Promise<void> => {
    const decider = await world.decider(`reader-${expected.toLowerCase()}`);
    const picked = await world.pickUp(decider, `a task read before ${expected}`);
    const read = { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId };

    const first = await world.asAgent(read, picked.credential);
    expect(isCommandRefusal(first)).toBe(false);
    expect(detailOf(first)['task']).toBeDefined();

    await change(picked, decider.grants);

    const again = await world.asAgent(read, picked.credential);
    expect(codeOf(again)).toBe(expected);
    expect(again).not.toHaveProperty('detail');
    expect(JSON.stringify(again)).not.toContain('a task read before');
    expect(await world.auditFor(read.operationId)).toStrictEqual([
      { outcome: 'applied', code: null },
      { outcome: 'refused', code: expected },
    ]);
  };

  it('refuses a repeated read once the delegating person’s read grant is revoked', async () => {
    await readTwice(async (_picked, grants) => {
      await world.revokeGrant(String(grants['read']));
    }, 'DELEGATION_NARROWED');
  });

  it('refuses a repeated read once the delegation is revoked', async () => {
    await readTwice(async (picked) => {
      await world.revokeDelegation(String(picked.detail['delegationId']));
    }, 'DELEGATION_NOT_LIVE');
  });

  it('refuses a repeated read once the delegation has expired', async () => {
    await readTwice(async (picked) => {
      await world.db.admin.execute(
        // Time passing, moved back rather than waited for: the grant moves with
        // the expiry so `delegations_expiry_after_grant` still holds.
        `update public.delegations
            set granted_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
          where business_id = $1 and id = $2`,
        [world.business, String(picked.detail['delegationId'])],
      );
    }, 'DELEGATION_NOT_LIVE');
  });

  it('refuses a repeated read presented without the credential', async () => {
    const decider = await world.decider('reader-bare');
    const picked = await world.pickUp(decider, 'a task read, then asked for bare');
    const read = { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId };
    expect(isCommandRefusal(await world.asAgent(read, picked.credential))).toBe(false);
    // Bare, the login is back to the queue and a pickup (contract 8.2 case 9).
    expect(codeOf(await world.asAgent(read))).toBe('DELEGATION_EXCLUDES_OPERATION');
  });

  it('returns the same comment handles on a lost-response replay, writing one comment', async () => {
    const decider = await world.decider('commenter');
    const picked = await world.pickUp(decider, 'a task commented on twice');
    const comment = {
      command: 'task.comment',
      operationId: randomUUID(),
      recordId: picked.taskId,
      body: 'a note for the team',
      audience: 'internal',
    };
    const first = await world.asAgent(comment, picked.credential);
    expect(isCommandRefusal(first)).toBe(false);
    const again = await world.asAgent(comment, picked.credential);
    expect(again).toStrictEqual(first);
    expect(await world.commentsOn(picked.taskId)).toBe(1);
  });

  it('never stores the delegation credential, and replays a pickup without it', async () => {
    const decider = await world.decider('picker');
    const picked = await world.pickUp(decider, 'a pickup whose response was lost');
    expect(picked.credential.length).toBeGreaterThan(20);

    const stored = await world.db.admin.execute<{ readonly result: string }>(
      `select result::text as result from public.operations
        where business_id = $1 and operation_id = $2`,
      [world.business, picked.operationId],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.result).not.toContain(picked.credential);

    const again = await world.asAgent({
      command: 'task.pickup',
      operationId: picked.operationId,
      reservationId: picked.reservationId,
    });
    expect(isCommandRefusal(again)).toBe(false);
    const replayed = detailOf(again);
    expect(JSON.stringify(again)).not.toContain(picked.credential);
    expect(replayed['credential']).toBeNull();
    expect(replayed['credentialNote']).toBe('CREDENTIAL_NOT_REPLAYED');
    for (const handle of ['leaseId', 'fence', 'delegationId', 'reservationId', 'taskId']) {
      expect(replayed[handle], handle).toStrictEqual(picked.detail[handle]);
    }
    const leases = await world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.leases where business_id = $1 and reservation_id = $2`,
      [world.business, picked.reservationId],
    );
    expect(Number(leases[0]?.n)).toBe(1);

    // The credential the first answer carried is still the live one.
    const read = await world.asAgent(
      { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
      picked.credential,
    );
    expect(isCommandRefusal(read)).toBe(false);
  });

  it('refuses a repeated pickup once its delegation is revoked', async () => {
    const decider = await world.decider('picker-revoked');
    const picked = await world.pickUp(decider, 'a pickup replayed after revocation');
    await world.revokeDelegation(String(picked.detail['delegationId']));
    const again = await world.asAgent({
      command: 'task.pickup',
      operationId: picked.operationId,
      reservationId: picked.reservationId,
    });
    expect(codeOf(again)).toBe('DELEGATION_NOT_LIVE');
    expect(again).not.toHaveProperty('detail');
  });

  it('returns a settled handback’s handles to the credential that settled it, and to nobody else', async () => {
    const decider = await world.decider('handing-back');
    const picked = await world.pickUp(decider, 'a handback whose response was lost');
    const handback = {
      command: 'task.handback',
      operationId: randomUUID(),
      leaseId: String(picked.detail['leaseId']),
      fence: Number(picked.detail['fence']),
      outcome: 'completed',
      report: { wrote: 'a draft' },
    };
    const first = await world.asAgent(handback, picked.credential);
    expect(isCommandRefusal(first)).toBe(false);
    expect(await world.asAgent(handback, picked.credential)).toStrictEqual(first);
    expect(codeOf(await world.asAgent(handback))).toBe('DELEGATION_NOT_LIVE');
    expect(codeOf(await world.asAgent(handback, 'not-the-credential'))).toBe('DELEGATION_NOT_LIVE');

    const reports = await world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.handback_reports where business_id = $1 and lease_id = $2`,
      [world.business, handback.leaseId],
    );
    expect(Number(reports[0]?.n)).toBe(1);
  });
});
