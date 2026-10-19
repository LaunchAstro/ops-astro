// SPDX-License-Identifier: AGPL-3.0-only
//
// No version written before 20261011155623 records the credential it was
// made under, so the upgrade cannot tell which Launch, if any, an agent's
// pending proposal belongs to. It refuses instead of guessing, links and
// withdraws nothing, and applies once a person has decided those proposals.
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
import { codeOf, type Decider } from './agent-fixture.ts';
import { grantTo } from './fixture.ts';

const LINK = '20261011155623_proposal_launch_delegation';
const GUARD = '20261011193804_pending_launch_proposals_refuse_upgrade';
/** The run outcome (#1623 R1): today's runtime reads a stopped attempt's outcome at pickup. */
const RUN_OUTCOMES = '20261019105500_run_outcomes.sql';

let prefixDirectory: string;
let w: AiWorld;
let r: Decider;
vi.mock('../support/fresh-database.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../support/fresh-database.ts')>();
  return {
    ...original,
    createFreshDatabase: async (options: Parameters<typeof original.createFreshDatabase>[0]) =>
      await original.createFreshDatabase({ ...options, migrationsDirectory: prefixDirectory }),
  };
});

beforeAll(async () => {
  prefixDirectory = mkdtempSync(join(tmpdir(), 'launch-upgrade-'));
  for (const file of readdirSync('migrations').filter(
    (name) => name.endsWith('.sql') && (name < LINK || name === RUN_OUTCOMES),
  )) {
    copyFileSync(join('migrations', file), join(prefixDirectory, file));
  }
  w = await aiWorld('launch_upgrade');
  r = await w.world.decider('r');
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

/** The owner assigns the task to the agent and `p` launches it: the Launch's delegation and credential. */
async function launched(taskId: string): Promise<{ id: string; credential: string }> {
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
      join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
     where l.task_id = $1 and l.state <> 'ended'`,
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
  return { id: delegation.id, credential };
}

// The head's command path on the real pre-upgrade schema, with the
// ten-column version INSERT the proposal writer used before the column.
const legacyWriter = (): Database => ({
  log: w.world.db.app.log,
  close: async () => {},
  withBusiness: async (businessId, work) =>
    await w.world.db.app.withBusiness(businessId, async (tx) => {
      const wrapped: TransactionQuery = {
        businessId: tx.businessId,
        savepoint: async (workInSavepoint) => await tx.savepoint(workInSavepoint),
        query: async <Row>(sql: string, parameters?: readonly unknown[]) =>
          sql.includes('insert into public.proposal_versions') && parameters?.length === 11
            ? await tx.query<Row>(
                sql.replace(', launch_delegation_id', '').replace(', $11', ''),
                parameters.slice(0, 10),
              )
            : await tx.query<Row>(sql, parameters),
      };
      return await work(wrapped);
    }),
});

/** The agent proposes on the task under `credential`, as it did before the upgrade. */
async function proposedUnder(
  credential: string,
  taskId: string,
  purpose = `legacy_${randomUUID().slice(0, 8)}`,
): Promise<{ gateId: string; versionId: string }> {
  const answer = await executeAgentCommand(
    legacyWriter(),
    w.world.business,
    { provider: 'supabase', subject: w.world.agentSubject() },
    credential,
    {
      command: 'task.propose',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(w, taskId),
      purpose,
      maximumMinor: 3000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    },
  );
  if (isCommandRefusal(answer)) throw new Error(answer.code);
  return answer.detail as { gateId: string; versionId: string };
}

const offered = async (gateId: string): Promise<readonly string[]> =>
  (
    await w.world.db.admin.execute<{ person: string }>(
      `select recipient_person_id::text as person from public.inbox_items
        where fact_id = $1 and reason = 'decision' and work_state = 'open'`,
      [gateId],
    )
  ).map((row) => row.person);

const linkApplied = async (): Promise<boolean> =>
  (await w.world.db.admin.execute(`select 1 from ops.schema_migrations where version = $1`, [LINK]))
    .length > 0;

/** The upgrade refuses, naming how many and what a person does, and leaves the database as it was. */
async function upgradeRefuses(gateId: string, offeredBefore: readonly string[]): Promise<void> {
  await w.world.db.closeSessions();
  await expect(migrate(w.world.db.admin, 'migrations')).rejects.toMatchObject({
    cause: { message: expect.stringMatching(/^1 pending launch proposal.*decide or cancel/su) },
  });
  expect(await linkApplied()).toBe(false);
  expect(await offered(gateId)).toEqual(offeredBefore);
}

/** `r`, neither launcher nor owner, decides: a pickup's reviewer, or a third person. */
async function rejectedByR(gate: { gateId: string; versionId: string }): Promise<void> {
  const decided = await w.world.asPerson(r, {
    command: 'task.decide',
    operationId: randomUUID(),
    gateId: gate.gateId,
    versionId: gate.versionId,
    decision: 'reject',
    note: 'Decided before the upgrade',
  });
  expect(codeOf(decided)).toBe('not-a-refusal');
}

it('refuses to upgrade while a launcher could approve a proposal whose delegation an earlier-started revocation ended', async () => {
  const taskId = await created(w, w.q, 'Revoked across the proposal');
  const launch = await launched(taskId);
  const gate = await proposedUnder(launch.credential, taskId);
  // A revocation whose transaction started before the proposal and committed
  // after it stamps `revoked_at` with its own start, before the version.
  await w.world.revokeDelegation(launch.id);
  await w.world.db.admin.execute(
    `update public.delegations d set revoked_at = v.created_at - interval '1 millisecond'
       from public.proposal_versions v where d.id = $1 and v.id = $2`,
    [launch.id, gate.versionId],
  );
  const before = await offered(gate.gateId);
  expect(before).toContain(w.p.personId);
  await upgradeRefuses(gate.gateId, before);
  await rejectedByR(gate);
}, 60_000);

it('refuses to upgrade while a pickup proposal sits on a task an unrelated Launch overlaps, keeping its reviewer', async () => {
  const picked = await w.world.pickUp(r, 'Picked up, then launched');
  await launched(picked.taskId);
  // Room in the task's envelope beside the run's hold: setup, not the path under test.
  await w.world.db.admin.execute(
    `update public.task_envelopes set maximum_minor = maximum_minor * 2 where task_id = $1`,
    [picked.taskId],
  );
  // A pickup's delegation holds the purpose of the version it picked up.
  const [scope] = await w.world.db.admin.execute<{ purpose: string }>(
    `select v.purpose from public.proposal_versions v
       join public.proposal_lineages pl on pl.business_id = v.business_id and pl.id = v.lineage_id
      where pl.task_id = $1`,
    [picked.taskId],
  );
  const gate = await proposedUnder(picked.credential, picked.taskId, scope?.purpose);
  const before = await offered(gate.gateId);
  expect(before).toContain(r.personId);
  await upgradeRefuses(gate.gateId, before);
  await rejectedByR(gate);
}, 60_000);

it('upgrades once a person has decided every pending launch proposal written before it', async () => {
  await w.world.db.closeSessions();
  const upgrade = await migrate(w.world.db.admin, 'migrations');
  // The two apply first, in order; migrations added after them come too.
  expect(upgrade.applied.slice(0, 2)).toEqual([LINK, GUARD]);
}, 60_000);
