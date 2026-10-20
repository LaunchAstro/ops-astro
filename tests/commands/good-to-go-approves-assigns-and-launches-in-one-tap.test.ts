// SPDX-License-Identifier: AGPL-3.0-only
//
// Good to go (#2233): one tap on the plan card approves the exact version,
// hands the task to the agent and launches its run, in one transaction. A
// business nobody gave a cap draws on the default one (AUD 50), written on
// its first approval; a run whose hold would take the business past its cap
// is refused, and so is every other refusal, writing nothing: no decision, no
// assignment, no launch. Crossings: another person's agent, a client's task,
// and a person of another business, whose own cap is never touched.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { codeOf, type Decider } from './agent-fixture.ts';
import { agentOwnedBy, enrol, grantTo, installSpine } from './fixture.ts';
import {
  CANARY,
  aiWorld,
  created,
  holder,
  ownedAgent,
  revisionOf,
  type AiWorld,
  type Gate,
} from './ai-assign-world.ts';

const APPLIED = 'not-a-refusal';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('good-to-go: DATABASE_URL is unset, so nothing ran.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await aiWorld('goodtogo');
  // A business nobody gave a cap: the world's seeded one removed.
  await w.world.db.admin.execute(`delete from public.budget_caps where business_id = $1`, [
    w.world.business,
  ]);
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** `by`'s proposal of a run on the task, holding at most `maximumMinor` AUD cents. */
async function proposes(by: Decider, taskId: string, maximumMinor: number): Promise<Gate> {
  const answer = await w.world.asPerson(by, {
    command: 'task.propose',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(w, taskId),
    purpose: `change_${randomUUID().slice(0, 8)}`,
    maximumMinor,
    currency: 'AUD',
    payload: { instruction: 'change the about page' },
    step: { kind: 'compose', payload: {} },
  });
  if (isCommandRefusal(answer)) throw new Error(`task.propose refused ${answer.code}`);
  return answer.detail as Gate;
}

const tap = async (by: Decider, gate: Gate, agent?: string): Promise<CommandResult> =>
  await w.world.asPerson(by, {
    command: 'task.approve_and_launch',
    operationId: randomUUID(),
    gateId: gate.gateId,
    versionId: gate.versionId,
    ...(agent === undefined ? {} : { agent }),
  });

const caps = async (business: string) =>
  await w.world.db.admin.execute<{
    readonly key: string;
    readonly limit: string;
    readonly currency: string;
  }>(
    `select key, limit_minor::text as limit, currency from public.budget_caps
      where business_id = $1 and key <> 'planning' order by key`,
    [business],
  );

/** What a refused tap must leave as it was: the gate, the holder and the task's launches. */
async function untouched(taskId: string, gate: Gate): Promise<void> {
  const [row] = await w.world.db.admin.execute<{ readonly state: string; readonly n: string }>(
    `select g.state, (select count(*) from public.gate_decisions d where d.gate_id = g.id)::text as n
       from public.gates g where g.id = $1`,
    [gate.gateId],
  );
  expect(row).toEqual({ state: 'pending', n: '0' });
  expect((await holder(w, taskId))?.agent ?? null).toBeNull();
  const [launches] = await w.world.db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.task_launches where task_id = $1`,
    [taskId],
  );
  expect(launches?.n).toBe('0');
}

describe.skipIf(serverUrl === undefined)('Good to go: one tap approves and launches', () => {
  it('a business with no cap gets the AUD 50 default, and one tap approves, assigns and launches', async () => {
    const task = await created(w, w.p, 'Change the about page');
    const agent = await ownedAgent(w, w.p);
    const gate = await proposes(w.q, task, 3_000);
    expect(await caps(w.world.business)).toEqual([]);

    const answer = await tap(w.p, gate, agent);
    expect(codeOf(answer)).toBe(APPLIED);
    expect(answer).toMatchObject({
      detail: { decision: 'approve', gateId: gate.gateId, state: 'waiting', heldMinor: 3_000 },
    });

    expect(await caps(w.world.business)).toEqual([
      { key: 'business', limit: '5000', currency: 'AUD' },
    ]);
    const [decided] = await w.world.db.admin.execute<{ readonly state: string }>(
      `select state from public.gates where id = $1`,
      [gate.gateId],
    );
    expect(decided?.state).toBe('approved');
    expect((await holder(w, task))?.agent).toBe(agent);
    const launches = await w.world.db.admin.execute<{
      readonly agent: string;
      readonly by: string;
    }>(
      `select l.agent_actor_id::text as agent, d.delegate_person_id::text as by
         from public.task_launches l
         join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
        where l.task_id = $1 and l.state = 'waiting'`,
      [task],
    );
    expect(launches).toEqual([{ agent, by: w.p.personId }]);
  });

  it('a run that would take the business past its cap is refused, writing nothing', async () => {
    // AUD 30 of the AUD 50 default is held by the first case's run.
    const task = await created(w, w.p, 'Change the contact page');
    const gate = await proposes(w.q, task, 3_000);
    const answer = await tap(w.p, gate, await ownedAgent(w, w.p));
    expect(codeOf(answer)).toBe('BUDGET_EXHAUSTED');
    await untouched(task, gate);
    expect(await caps(w.world.business)).toEqual([
      { key: 'business', limit: '5000', currency: 'AUD' },
    ]);
  });

  it("a refused launch takes the approval back: a client's task", async () => {
    const task = await created(w, w.p, 'Change a client page');
    const gate = await proposes(w.q, task, 1_000);
    await w.world.db.admin.execute(
      `update public.records set uuid_7 = $2::uuid,
              data = data || jsonb_build_object('client', $2::text) where id = $1`,
      [task, randomUUID()],
    );
    expect(codeOf(await tap(w.p, gate, await ownedAgent(w, w.p)))).toBe('LAUNCH_CLIENT_TASK');
    await untouched(task, gate);
  });

  it("another person's agent is not this person's to launch", async () => {
    const task = await created(w, w.p, 'Change the services page');
    const gate = await proposes(w.p, task, 1_000);
    expect(codeOf(await tap(w.q, gate, await ownedAgent(w, w.p)))).toBe('SCOPE_NOT_GRANTED');
    await untouched(task, gate);
  });

  it('a tap with no agent and none holding the task is refused, writing nothing', async () => {
    const task = await created(w, w.p, 'Change the team page');
    const gate = await proposes(w.q, task, 1_000);
    expect(codeOf(await tap(w.p, gate))).toBe('LAUNCH_NO_AGENT');
    await untouched(task, gate);
  });

  it("a person of another business cannot tap here, and that business's cap is never touched", async () => {
    const task = await created(w, w.p, `Change ${CANARY}`);
    const gate = await proposes(w.q, task, 1_000);
    const bravo = await insertBusiness(w.world.db.app, `tap-b-${randomUUID().slice(0, 8)}`);
    await installSpine(w.world.db.app, bravo);
    const there = await enrol(w.world.db.app, bravo, 'there');
    await w.world.db.app.withBusiness(bravo, async (tx) => {
      for (const action of ['read', 'write', 'decide', 'assign'] as const) {
        // oxlint-disable-next-line no-await-in-loop -- four grants
        await grantTo(tx, there, action);
      }
      await grantTo(tx, there, 'assign', undefined, false, 'agent');
      await tx.query(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'local', 77700, 'AUD')`,
        [bravo, randomUUID()],
      );
    });
    const theirs = await agentOwnedBy(w.world.db.app, bravo, there.personId);
    const answer = await executeCommand(w.world.db.app, bravo, there.presented, 'api', {
      command: 'task.approve_and_launch',
      operationId: randomUUID(),
      gateId: gate.gateId,
      versionId: gate.versionId,
      agent: theirs,
    } as never);
    expect(codeOf(answer)).toBe('NOT_FOUND');
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect(JSON.stringify(answer)).not.toContain(task);
    await untouched(task, gate);
    expect(await caps(bravo)).toEqual([{ key: 'local', limit: '77700', currency: 'AUD' }]);

    // And this business's own tap leaves the other's cap as it was.
    expect(codeOf(await tap(w.p, gate, await ownedAgent(w, w.p)))).toBe(APPLIED);
    expect(await caps(bravo)).toEqual([{ key: 'local', limit: '77700', currency: 'AUD' }]);
  });
});
