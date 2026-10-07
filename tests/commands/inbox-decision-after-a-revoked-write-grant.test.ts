// SPDX-License-Identifier: AGPL-3.0-only
//
// A revoked grant can take a task's agent away: `grant.revoke` of the only
// `write` its delegating person held costs the agent's live lease its
// authority, so the delegation is revoked (`authority_lost`) and cleared from
// the task. The person who still holds decide is owed the pending gate again,
// one open item, and decides it. A person whose decide went first is owed
// nothing back, and a person assignee stays owed nothing (four eyes).
//
// Each case enrols a person of its own, holding `write` once. Q proposes twice
// before any approval, each on a lineage of its own, so the second gate
// neither supersedes the first nor retires the agent's work. The person
// approves the first, the agent picks it up for an hour, and the person
// assigns that agent the task, which withdraws their item on the second.

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

type Gate = { readonly gateId: string; readonly versionId: string };

/** A proposal by Q on a lineage of its own. */
async function proposed(task: string): Promise<Gate> {
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
  });
  if (isCommandRefusal(answer)) throw new Error(`task.propose refused ${answer.code}`);
  const detail = answer.detail as Gate;
  return { gateId: detail.gateId, versionId: detail.versionId };
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
  const agent = String(detailOf(picked)['delegationId']);
  expect(codeOf(await assign(w, person, task, { agent }))).toBe('not-a-refusal');
  expect(await itemsOf(second, person.personId)).toBe(0);
  return { person, task, first, second, agent };
}

describe.skipIf(serverUrl === undefined)('decision items: a revoked grant takes the agent', () => {
  it('revoking the only write grant gives the person who keeps decide the decision back', async () => {
    const { person, task, first, second, agent } = await leasedAndHeld('Write revoked');
    await w.world.revokeGrant(person.grants.write);
    expect(await causeOf(agent)).toBe('authority_lost');
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
    expect(await itemsOf(second, person.personId)).toBe(1);
    expect(await itemsOf(second, w.q.personId)).toBe(1);
    // The approved gate is no pending one, so nothing on it comes back.
    expect(await itemsOf(first, person.personId)).toBe(0);
    expect(codeOf(await decide(person, second, 'reject'))).toBe('not-a-refusal');
  });

  it('a person whose decide was revoked first is owed nothing back', async () => {
    const { person, task, second, agent } = await leasedAndHeld('Decide, then write, revoked');
    await w.world.revokeGrant(person.grants.decide);
    await w.world.revokeGrant(person.grants.write);
    expect(await causeOf(agent)).toBe('authority_lost');
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
    expect(await itemsOf(second, person.personId)).toBe(0);
    expect(await itemsOf(second, w.q.personId)).toBe(1);
    expect(codeOf(await decide(person, second, 'reject'))).toBe('SCOPE_NOT_GRANTED');
  });

  it('a person assignee stays owed nothing while the agent’s person is owed it back', async () => {
    const { person, task, second, agent } = await leasedAndHeld('Write revoked, Q assigned');
    expect(codeOf(await assign(w, person, task, { assignee: w.q.personId }))).toBe('not-a-refusal');
    await w.world.revokeGrant(person.grants.write);
    expect(await causeOf(agent)).toBe('authority_lost');
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: w.q.personId });
    expect(await itemsOf(second, person.personId)).toBe(1);
    expect(await itemsOf(second, w.q.personId)).toBe(0);
    expect(codeOf(await decide(w.q, second, 'reject'))).toBe('FOUR_EYES_REQUIRED');
  });
});
