// SPDX-License-Identifier: AGPL-3.0-only
//
// A Launch proposal written before 20261011155623, and still pending when it
// is applied, is linked to its Launch by the upgrade: its launcher is no
// longer offered the decision and is refused it. Body kept as written for
// the PR's review.
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  configuredCredentialKeys,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/index.ts';
import { migrate } from '../../packages/core-records/src/tenancy/migrate.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { aiWorld, assign, created, revisionOf, type AiWorld } from './ai-assign-world.ts';
import { codeOf } from './agent-fixture.ts';
import { grantTo } from './fixture.ts';

let prefixDirectory: string;
let w: AiWorld;
vi.mock('../support/fresh-database.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../support/fresh-database.ts')>();
  return {
    ...original,
    createFreshDatabase: async (options: Parameters<typeof original.createFreshDatabase>[0]) =>
      await original.createFreshDatabase({ ...options, migrationsDirectory: prefixDirectory }),
  };
});

beforeAll(async () => {
  prefixDirectory = mkdtempSync(join(tmpdir(), 'sol-launch-upgrade-'));
  for (const file of readdirSync('migrations').filter(
    (name) => name.endsWith('.sql') && name < '20261011155623',
  )) {
    copyFileSync(join('migrations', file), join(prefixDirectory, file));
  }
  w = await aiWorld('sol_upgrade');
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, w.p, 'assign', undefined, false, 'agent');
  });
  await w.world.db.admin.execute('update public.actors set owner_person_id = $1 where id = $2', [
    w.q.personId,
    w.world.agentActorId,
  ]);
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
  if (prefixDirectory !== undefined) rmSync(prefixDirectory, { recursive: true, force: true });
});

it('upgrading a pending launch proposal keeps its launcher out of the inbox and decision', async () => {
  const taskId = await created(w, w.q, 'Pending across upgrade');
  expect(codeOf(await assign(w, w.q, taskId, { agent: w.world.agentActorId }))).toBe(
    'not-a-refusal',
  );
  expect(
    codeOf(
      await w.world.asPerson(w.p, {
        command: 'task.launch',
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: await revisionOf(w, taskId),
      }),
    ),
  ).toBe('not-a-refusal');
  const [delegation] = await w.world.db.admin.execute<{ id: string; key: string }>(
    `select d.id, d.credential_key_id as key from public.task_launches l
      join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id where l.task_id = $1`,
    [taskId],
  );
  const keys = configuredCredentialKeys();
  if (!keys.ok || delegation === undefined) throw new Error('Missing launch');
  const credential = keys.keys.derive(delegation.key, {
    businessId: w.world.business,
    agentActorId: w.world.agentActorId,
    delegationId: delegation.id,
  });
  if (credential === undefined) throw new Error('Missing credential key');

  // Use the head's command path on the real pre-upgrade schema, with the
  // exact ten-column version INSERT that the pre-fix proposal writer used.
  // No authority, decision, inbox or migration behaviour is mocked.
  let legacyInsertCount = 0;
  const legacyWriter: Database = {
    log: w.world.db.app.log,
    close: async () => {},
    withBusiness: async (businessId, work) =>
      await w.world.db.app.withBusiness(businessId, async (tx) => {
        const wrapped: TransactionQuery = {
          businessId: tx.businessId,
          savepoint: async (workInSavepoint) => await tx.savepoint(workInSavepoint),
          query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
            if (sql.includes('insert into public.proposal_versions')) {
              expect(parameters).toHaveLength(11);
              legacyInsertCount += 1;
              return await tx.query<Row>(
                sql.replace(', launch_delegation_id', '').replace(', $11', ''),
                parameters?.slice(0, 10),
              );
            }
            return await tx.query<Row>(sql, parameters);
          },
        };
        return await work(wrapped);
      }),
  };
  const answer = await executeAgentCommand(
    legacyWriter,
    w.world.business,
    { provider: 'supabase', subject: w.world.agentSubject() },
    credential,
    {
      command: 'task.propose',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(w, taskId),
      purpose: 'legacy_launch',
      maximumMinor: 3000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    },
  );
  if (isCommandRefusal(answer)) throw new Error(answer.code);
  expect(legacyInsertCount).toBe(1);
  const gate = answer.detail as { gateId: string; versionId: string };
  const offered = async () =>
    (
      await w.world.db.admin.execute<{ person: string }>(
        `select recipient_person_id::text as person from public.inbox_items
      where fact_id = $1 and reason = 'decision' and work_state = 'open'`,
        [gate.gateId],
      )
    ).map((row) => row.person);
  // Establish the actual vulnerable state before applying the fix migration.
  expect(await offered()).toContain(w.p.personId);
  await w.world.db.closeSessions();
  const upgrade = await migrate(w.world.db.admin, 'migrations');
  expect(upgrade.applied).toEqual(['20261011155623_proposal_launch_delegation']);
  expect.soft(await offered()).not.toContain(w.p.personId);
  const decided = await w.world.asPerson(w.p, {
    command: 'task.decide',
    operationId: randomUUID(),
    gateId: gate.gateId,
    versionId: gate.versionId,
    decision: 'approve',
    note: 'Launcher cannot independently approve',
  });
  expect(codeOf(decided)).toBe('FOUR_EYES_REQUIRED');
}, 30_000);
