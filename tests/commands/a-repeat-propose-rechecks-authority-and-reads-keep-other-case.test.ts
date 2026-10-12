// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's repeat propose of a purpose it has waiting is judged like any
// proposal: authority is read after the task lock is held, so a write grant
// revoked while it waited refuses it. And only a read's identifier fields are
// lowercased: a preset name that happens to look like a uuid keeps its case.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { mintDelegation } from '../../packages/core-records/src/index.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { grantTo } from '../commands/fixture.ts';
import { hold } from '../support/lock-waits.ts';

let world: AgentWorld;
let decider: Decider;

const serverUrl = databaseUrlFromEnvironment();

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('rpa', `repeat-propose-${randomUUID().slice(0, 8)}`);
  decider = await world.decider('proposer');
}, 180_000);

afterAll(async () => {
  await world?.drop();
});

describe.skipIf(serverUrl === undefined)('a repeat propose and a read’s identifier fields', () => {
  it('preset names retain their case when they happen to look like UUIDs', async () => {
    await world.db.app.withBusiness(world.business, async (tx) => {
      await grantTo(tx, decider, 'manage');
    });
    const presetKey = 'ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF';
    const answer = await executeRead(world.db.app, world.business, decider.presented, {
      read: 'preset.plan',
      recordTypeKey: 'task',
      presetKey,
      fields: [],
    });
    expect(answer).toHaveProperty('plan.presetKey', presetKey);
  });

  it('reusing a pending proposal rechecks authority after waiting for the task lock', async () => {
    const made = await world.asPerson(decider, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'revoked while waiting' },
    });
    if (isCommandRefusal(made) || made.recordId === null) throw new Error('task creation failed');
    const taskId = made.recordId;
    const credential = await world.db.app.withBusiness(world.business, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: world.agentActorId,
        delegatePersonId: decider.personId,
        mintedByActorId: decider.actorId,
        purpose: 'revocation_proof',
        collections: ['task'],
        actions: ['read', 'write'],
        purposeScope: { kind: 'record', id: taskId },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(`mint failed ${minted.refusal.code}`);
      return minted.value.credential;
    });
    const [task] = await world.db.admin.execute<{ revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [taskId],
    );
    const proposal = {
      command: 'task.propose',
      recordId: taskId,
      expectedRevision: Number(task?.revision),
      purpose: 'draft',
      maximumMinor: 100,
      currency: 'AUD',
      payload: {},
      step: { kind: 'compose', payload: {} },
    };
    const first = await world.asAgent({ ...proposal, operationId: randomUUID() }, credential);
    expect(isCommandRefusal(first)).toBe(false);
    let holderPid = 0;
    const held = await hold(world.db.appUrl, world.business, async (tx) => {
      const [backend] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      holderPid = backend?.pid ?? 0;
      await tx.query('select id from public.records where id = $1 for update', [taskId]);
    });
    const pending = world.asAgent({ ...proposal, operationId: randomUUID() }, credential);
    try {
      await expect
        .poll(
          async () => {
            const [blocked] = await world.db.admin.execute<{ n: number }>(
              'select count(*)::int as n from pg_stat_activity where datname = current_database() and $1 = any(pg_blocking_pids(pid))',
              [holderPid],
            );
            return blocked?.n;
          },
          { timeout: 10_000 },
        )
        .toBe(1);
      await world.db.admin.execute(
        'update public.grants set revoked_at = clock_timestamp() where id = $1',
        [decider.grants.write],
      );
      await held.letGo();
      const answer = await pending;
      expect(isCommandRefusal(answer) ? answer.code : 'applied').toBe('SCOPE_NOT_GRANTED');
    } finally {
      await held.letGo();
      await pending.catch(() => undefined);
    }
  }, 30_000);
});
