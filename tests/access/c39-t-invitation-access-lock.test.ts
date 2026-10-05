// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop -- each wait observes the preceding database state */
/* eslint-disable max-lines-per-function -- each proof holds its revocation schedule in one place */
//
// C39-T: an invitation act asks its grants again under the business's access
// lock, which every revocation holds until it commits. A revocation that has
// written but not yet committed is waited for, then refuses the act; read
// without the lock it would still look live and the act would commit after it.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { lockAccess, revokeGrant } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { addressFor, c, codeOf, invite, noDatabase, useInvitationWorld, w } from './c39-t-world.ts';

useInvitationWorld();

const releaseNothing = () => {};

function latch() {
  let release = releaseNothing;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A person holding `access:share`, and `access:manage` when asked; their grant ids. */
async function inviter(
  name: string,
  manage = false,
): Promise<{ who: Member; share: string; manage: string }> {
  const who = await enrol(w.db.app, w.alpha, name);
  return await w.db.app.withBusiness(w.alpha, async (tx) => ({
    who,
    share: await grantTo(tx, who, 'share', undefined, false, 'access'),
    manage: manage ? await grantTo(tx, who, 'manage', undefined, false, 'access') : '',
  }));
}

/**
 * `grantId` revoked on its own connection under the access lock and held
 * uncommitted while `command` runs as `who` on another; committed once the
 * command waits on it, or has finished without waiting.
 */
async function underRevocation(
  grantId: string,
  who: Member,
  command: string,
  body: Readonly<Record<string, unknown>>,
): Promise<CommandResult> {
  const acting = connect(w.db.appUrl, { log: w.db.log });
  const revoker = connect(w.db.appUrl);
  const held = latch();
  const release = latch();
  let pid = 0;
  const holding = revoker.withBusiness(w.alpha, async (tx) => {
    const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
    pid = row?.pid ?? 0;
    await lockAccess(tx);
    expect(await revokeGrant(tx, grantId)).not.toBeNull();
    held.release();
    await release.promise;
  });
  try {
    await held.promise;
    let finished = false;
    const running = executeCommand(acting, w.alpha, who.presented, 'api', {
      command,
      operationId: randomUUID(),
      ...body,
    } as never).finally(() => {
      finished = true;
    });
    const until = Date.now() + 5000;
    for (;;) {
      const [row] = await w.db.admin.execute<{ waiting: boolean }>(
        'select exists (select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as waiting',
        [pid],
      );
      if (finished || row?.waiting === true) break;
      if (Date.now() >= until) throw new Error('Timed out waiting for the database schedule');
      await delay(20);
    }
    release.release();
    return await running;
  } finally {
    release.release();
    await holding;
    await revoker.close();
    await acting.close();
  }
}

/** One command as Avery Admin on `pool`, its own connection. */
async function act(
  pool: ReturnType<typeof connect>,
  body: Readonly<Record<string, unknown>>,
): Promise<CommandResult> {
  return await executeCommand(pool, w.alpha, c.admin.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);
}

async function countOf(sql: string, value: string): Promise<number> {
  const [row] = await w.db.admin.execute<{ n: number }>(sql, [value]);
  return row?.n ?? -1;
}

describe.skipIf(noDatabase)('C39-T invitation acts wait for a revocation in flight', () => {
  it('a member invitation is refused once its inviter loses access:share', async () => {
    const pat = await inviter('Pat Sharer');
    const address = addressFor('member');
    const result = await underRevocation(pat.share, pat.who, 'invitation.create', {
      name: 'Ivy Member',
      email: address,
      role: 'member',
    });
    expect(codeOf(result)).toBe('SCOPE_NOT_GRANTED');
    expect(
      await countOf(
        'select count(*)::int as n from public.invitations where address = $1',
        address,
      ),
    ).toBe(0);
    expect(
      await countOf(
        `select count(*)::int as n from public.audit_events
          where actor_id = $1 and command = 'invitation.create' and outcome = 'applied'`,
        pat.who.actorId,
      ),
    ).toBe(0);
  });

  it("an administrator's invitation is not resent once its inviter loses access:manage", async () => {
    const pat = await inviter('Pat Manager', true);
    const id = await invite(pat.who, addressFor('admin'), 'admin');
    const before = await countOf('select revision as n from public.invitations where id = $1', id);
    const result = await underRevocation(pat.manage, pat.who, 'invitation.resend', {
      invitationId: id,
    });
    expect(codeOf(result)).toBe('SCOPE_NOT_GRANTED');
    expect(await countOf('select revision as n from public.invitations where id = $1', id)).toBe(
      before,
    );
  });

  it('an invitation is not revoked once its revoker loses access:share', async () => {
    const pat = await inviter('Pat Revoker');
    const id = await invite(pat.who, addressFor('revoked'));
    const result = await underRevocation(pat.share, pat.who, 'invitation.revoke', {
      invitationId: id,
    });
    expect(codeOf(result)).toBe('SCOPE_NOT_GRANTED');
    const [row] = await w.db.admin.execute<{ state: string }>(
      'select state from public.invitations where id = $1',
      [id],
    );
    expect(row?.state).toBe('pending');
  });

  it("a create locks its address's pending invitations before the access lock, as a revoke does", async () => {
    // SEC-P3B-5: a create took the access lock before a lapsed invitation's
    // row, a revoke takes the row first; the two could deadlock.
    const address = addressFor('lapsed');
    const id = await invite(c.admin, address);
    await w.db.admin.execute(
      "update public.invitations set expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [id],
    );
    const creating = connect(w.db.appUrl, { log: w.db.log });
    const revoking = connect(w.db.appUrl, { log: w.db.log });
    const holder = connect(w.db.appUrl);
    const held = latch();
    const release = latch();
    let pid = 0;
    const holding = holder.withBusiness(w.alpha, async (tx) => {
      const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      pid = row?.pid ?? 0;
      await lockAccess(tx);
      held.release();
      await release.promise;
    });
    const waiting = async (sql: string, n: number): Promise<void> => {
      const until = Date.now() + 5000;
      for (;;) {
        const [row] = await w.db.admin.execute<{ n: number }>(sql, [pid]);
        if (row?.n === n) return;
        if (Date.now() >= until) throw new Error('Timed out waiting for the database schedule');
        await delay(20);
      }
    };
    const onHolder =
      'select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))';
    const blocked =
      'select count(*)::int as n from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0 and $1 <> pid';
    const acts: Promise<CommandResult>[] = [];
    try {
      await held.promise;
      const created = act(creating, {
        command: 'invitation.create',
        name: 'Ivy Again',
        email: address,
        role: 'member',
      });
      acts.push(created);
      await waiting(onHolder, 1);
      const revoked = act(revoking, { command: 'invitation.revoke', invitationId: id });
      acts.push(revoked);
      await waiting(blocked, 2);
      // The revoke waits on the create's row lock, not beside it on the access lock.
      const [direct] = await w.db.admin.execute<{ n: number }>(onHolder, [pid]);
      expect(direct?.n).toBe(1);
      release.release();
      expect(codeOf(await created)).toBe('applied');
      expect(codeOf(await revoked)).toBe('TRANSITION_NOT_PERMITTED');
    } finally {
      release.release();
      await holding;
      await Promise.allSettled(acts);
      await holder.close();
      await revoking.close();
      await creating.close();
    }
  });
});
