// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/index.ts';
import { endOwnSession } from '../../packages/core-records/src/identity/sessions.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { noDatabase, useAw06World, w } from './aw-06-world.ts';
import { leased } from './aw-08-gate-world.ts';
import { awaitParked, barrier, codeOf, racer, rows } from './schedules-harness.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('topup_session_end');

// eslint-disable-next-line max-lines-per-function -- one schedule: install held, the top-up parked, the session ended, then released
it('a session ended during the settings wait cannot commit a top-up', async () => {
  const owner = w.s;
  const work = await leased(owner, 'launch', 'session ending during the settings wait');
  const [before] = await rows<{ maximum: string }>(
    owner,
    `select maximum_minor::text as maximum from public.task_envelopes
      where business_id = $1 and task_id = $2 and state = 'open'`,
    [owner.business, work.taskId],
  );
  if (before === undefined) throw new Error('fixture has no envelope');
  const presented = { ...owner.decider.presented, sessionId: randomUUID() };
  const installer = racer(owner);
  const approver = racer(owner);
  const installed = barrier();
  const finish = barrier();
  const installing = installer.withBusiness(owner.business, async (tx) => {
    await installBusinessSettings(tx);
    installed.release();
    await finish.held;
  });
  await installed.held;
  const body = {
    command: 'budget.top_up',
    operationId: randomUUID(),
    recordId: work.taskId,
    amountMinor: 10_000,
    fromMaximumMinor: Number(before.maximum),
  };
  const topping = executeCommand(approver, owner.business, presented, 'api', body as never);
  try {
    await awaitParked(owner, 'advisory', 1);
    const waiting = await rows<{ query: string }>(
      owner,
      `select a.query from pg_stat_activity a join pg_locks l on l.pid = a.pid
        where a.datname = current_database() and l.locktype = 'advisory' and not l.granted`,
      [],
    );
    expect(waiting.map((row) => row.query)).toEqual([
      'select pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
    ]);
    await owner.db.app.withBusiness(owner.business, async (tx) => {
      expect(await endOwnSession(tx, owner.decider.personId, presented.sessionId)).toBe(1);
    });
    const afterRevocation = await executeCommand(owner.db.app, owner.business, presented, 'api', {
      ...body,
      operationId: randomUUID(),
    } as never);
    expect(codeOf(afterRevocation)).toBe('AUTH_SESSION_EXPIRED');
    finish.release();
    await installing;
    const answer = await topping;
    expect
      .soft(codeOf(answer), 'the session ending committed before the money decision resumed')
      .toBe('AUTH_SESSION_EXPIRED');
    expect
      .soft(
        await rows(
          owner,
          `select maximum_minor::text as maximum from public.task_envelopes
        where business_id = $1 and task_id = $2 and state = 'open'`,
          [owner.business, work.taskId],
        ),
        'a revoked session must raise no money',
      )
      .toEqual([before]);
  } finally {
    finish.release();
    await Promise.allSettled([installing, topping]);
    await installer.close();
    await approver.close();
  }
}, 60_000);
