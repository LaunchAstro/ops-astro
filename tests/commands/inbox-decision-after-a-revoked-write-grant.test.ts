// SPDX-License-Identifier: AGPL-3.0-only
//
// A revoked grant or retired work ends an agent's run, and never takes the
// task from the agent (Assign to AI): the assignment stays until a person
// changes it. `grant.revoke` of the only `write` the agent's owner held costs
// the agent's live lease its authority, so the delegation is revoked
// (`authority_lost`); cancelling or superseding the work retires it
// (`work_retired`). Either way the agent still holds the task, so four eyes
// still counts its owner as assigned: the owner is owed no decision item and
// is refused the gate. A person assignee, once one replaces the agent, is
// owed nothing either, and the owner is owed the gate again.
//
// Each case enrols a person of its own, holding `write` once, who owns the
// world's agent for that case. Q proposes twice before any approval, each on
// a lineage of its own. The person approves the first, the agent picks it up
// for an hour, and the person assigns that agent the task, which withdraws
// their item on the second.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf, type Decider } from './agent-fixture.ts';
import { grantTo } from './fixture.ts';
import { aiWorld, assign, created, holder, revisionOf, type AiWorld } from './ai-assign-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('inbox-decision-after-a-revoked-write-grant: no DB.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('revokedwrite');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

type Gate = { readonly gateId: string; readonly versionId: string; readonly lineageId: string };

/** A proposal by Q on a lineage of its own, or a new version on `lineageId`. */
async function proposed(task: string, lineageId?: string): Promise<Gate> {
  const answer = await w.world.asPerson(w.q, {
    command: 'task.propose',
    operationId: randomUUID(),
    recordId: task,
    expectedRevision: await revisionOf(w, task),
    purpose: `grant_${randomUUID().slice(0, 8)}`,
    maximumMinor: 3_000,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
    ...(lineageId === undefined ? {} : { lineageId }),
  });
  if (isCommandRefusal(answer)) throw new Error(`task.propose refused ${answer.code}`);
  const detail = answer.detail as Gate;
  return { gateId: detail.gateId, versionId: detail.versionId, lineageId: detail.lineageId };
}

const decide = async (by: Decider, gate: Gate, decision: 'approve' | 'reject') =>
  await w.world.asPerson(by, {
    command: 'task.decide',
    operationId: randomUUID(),
    gateId: gate.gateId,
    versionId: gate.versionId,
    decision,
    note: 'decided around the agent',
  });

/** How many open decision items the person holds on the gate. */
const itemsOf = async (gate: Gate, person: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.inbox_items
          where reason = 'decision' and fact_id = $1 and recipient_person_id = $2
            and work_state = 'open'`,
        [gate.gateId, person],
      )
    )[0]?.n ?? '0',
  );

/** How many open assignment items the person holds on the task. */
const assignmentsOf = async (task: string, person: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.inbox_items
          where reason = 'assignment' and subject_record_id = $1 and recipient_person_id = $2
            and work_state = 'open'`,
        [task, person],
      )
    )[0]?.n ?? '0',
  );

const causeOf = async (delegationId: string): Promise<string | null | undefined> =>
  (
    await w.world.db.admin.execute<{ readonly cause: string | null }>(
      `select revocation_cause as cause from public.delegations where id = $1`,
      [delegationId],
    )
  )[0]?.cause;

/** The person, the task their agent holds on a live lease, and Q's two gates on it. */
async function leasedAndHeld(title: string) {
  const person = await w.world.decider(`p-${randomUUID().slice(0, 8)}`);
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, person, 'assign');
  });
  await w.world.db.admin.execute(`update public.actors set owner_person_id = $2 where id = $1`, [
    w.world.agentActorId,
    person.personId,
  ]);
  const task = await created(w, person, title);
  const first = await proposed(task);
  const second = await proposed(task);
  const approved = await decide(person, first, 'approve');
  const picked = await w.world.asAgent({
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: detailOf(approved)['reservationId'],
    leaseSeconds: 3_600,
  });
  expect(codeOf(picked)).toBe('not-a-refusal');
  const delegation = String(detailOf(picked)['delegationId']);
  const agent = w.world.agentActorId;
  expect(codeOf(await assign(w, person, task, { agent }))).toBe('not-a-refusal');
  expect(await itemsOf(second, person.personId)).toBe(0);
  return { person, task, first, second, agent, delegation };
}

describe.skipIf(serverUrl === undefined)('decision items: a revoked grant keeps the agent', () => {
  it('revoking the only write grant ends the run; the agent keeps the task, its owner owed nothing', async () => {
    const { person, task, first, second, agent, delegation } = await leasedAndHeld('Write revoked');
    await w.world.revokeGrant(person.grants.write);
    expect(await causeOf(delegation)).toBe('authority_lost');
    expect(await holder(w, task)).toStrictEqual({ agent, person: null });
    expect(await itemsOf(second, person.personId)).toBe(0);
    expect(await itemsOf(second, w.q.personId)).toBe(1);
    expect(await itemsOf(first, person.personId)).toBe(0);
    expect(codeOf(await decide(person, second, 'reject'))).toBe('FOUR_EYES_REQUIRED');
    expect(codeOf(await decide(w.q, second, 'reject'))).toBe('not-a-refusal');
  });

  it('a person assignee replacing the agent is owed nothing, and the owner is owed the gate', async () => {
    const { person, task, second, delegation } = await leasedAndHeld('Q assigned, write revoked');
    expect(codeOf(await assign(w, person, task, { assignee: w.q.personId }))).toBe('not-a-refusal');
    // A person write replaces the agent (`oneKind`): no task holds both.
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: w.q.personId });
    expect(await assignmentsOf(task, w.q.personId)).toBe(1);
    await w.world.revokeGrant(person.grants.write);
    expect(await causeOf(delegation)).toBe('authority_lost');
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: w.q.personId });
    expect(await assignmentsOf(task, w.q.personId)).toBe(1);
    expect(await itemsOf(second, person.personId)).toBe(1);
    expect(await itemsOf(second, w.q.personId)).toBe(0);
    expect(codeOf(await decide(w.q, second, 'reject'))).toBe('FOUR_EYES_REQUIRED');
  });
});

describe.skipIf(serverUrl === undefined)('decision items: retired work keeps the agent', () => {
  it('cancelling the agent’s lineage retires its run; the agent keeps the task', async () => {
    const { person, task, first, second, agent, delegation } =
      await leasedAndHeld('First lineage cancelled');
    const cancelled = await w.world.asPerson(w.q, {
      command: 'task.cancel',
      operationId: randomUUID(),
      recordId: task,
      lineageId: first.lineageId,
      reason: 'Stop this work',
    });
    expect(codeOf(cancelled)).toBe('not-a-refusal');
    expect(await causeOf(delegation)).toBe('work_retired');
    expect(await holder(w, task)).toStrictEqual({ agent, person: null });
    expect(await itemsOf(second, person.personId)).toBe(0);
    expect(codeOf(await decide(person, second, 'reject'))).toBe('FOUR_EYES_REQUIRED');
  });

  it('superseding the agent’s version retires its run; the agent keeps the task', async () => {
    const { person, task, first, agent, delegation } = await leasedAndHeld('First superseded');
    const successor = await proposed(task, first.lineageId);
    expect(await causeOf(delegation)).toBe('work_retired');
    expect(await holder(w, task)).toStrictEqual({ agent, person: null });
    expect(await itemsOf(successor, person.personId)).toBe(0);
    expect(await itemsOf(successor, w.q.personId)).toBe(1);
  });
});
