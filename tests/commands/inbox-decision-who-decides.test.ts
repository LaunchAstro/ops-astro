// SPDX-License-Identifier: AGPL-3.0-only
//
// A decision item goes to a person `task.decide` would let decide, and the
// unattended list counts a decision attended only through such a person. Two
// people hold decide and are still refused: the person whose agent holds the
// task (Assign to AI), whom four eyes refuses `FOUR_EYES_REQUIRED` as it
// refuses a person assignee, and a holder of decide on the task's client
// alone, whom decide refuses `SCOPE_NOT_GRANTED` because it asks decide on the
// task itself. Neither is raised a decision item nor counted a path.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { readUnattended } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from './agent-fixture.ts';
import { addClient, grantTo } from './fixture.ts';
import { aiWorld, assign, created, minted, revisionOf, type AiWorld } from './ai-assign-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('inbox-decision-who-decides: DATABASE_URL is unset.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('whodecides');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

type Gate = { readonly gateId: string; readonly versionId: string };

/** A proposal on the task by Q, which raises the decision items. */
async function proposed(task: string): Promise<Gate> {
  const answer = await w.world.asPerson(w.q, {
    command: 'task.propose',
    operationId: randomUUID(),
    recordId: task,
    expectedRevision: await revisionOf(w, task),
    purpose: `gate_${randomUUID().slice(0, 8)}`,
    maximumMinor: 3_000,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
  });
  if (isCommandRefusal(answer)) throw new Error(`task.propose refused ${answer.code}`);
  const detail = answer.detail as Gate;
  return { gateId: detail.gateId, versionId: detail.versionId };
}

const decide = async (by: AiWorld['p'], gate: Gate) =>
  await w.world.asPerson(by, {
    command: 'task.decide',
    operationId: randomUUID(),
    gateId: gate.gateId,
    versionId: gate.versionId,
    decision: 'approve',
    note: 'who may decide',
  });

/** The open decision items on the gate: their ids and recipients. */
const openItems = async (gate: Gate) =>
  await w.world.db.admin.execute<{ readonly id: string; readonly person: string }>(
    `select id::text as id, recipient_person_id::text as person from public.inbox_items
      where reason = 'decision' and fact_id = $1 and work_state = 'open' order by id`,
    [gate.gateId],
  );

/**
 * Whether every open item on the gate is listed unattended once every
 * recipient but `kept` has lost their sign-in, so `kept` is the only one who
 * could hold the decision. The logins come back after.
 */
async function unattendedWithOnly(gate: Gate, kept: string): Promise<boolean> {
  const items = await openItems(gate);
  const others = [...new Set(items.map((item) => item.person))].filter((one) => one !== kept);
  expect(items.some((item) => item.person === kept)).toBe(true);
  const admin = w.world.db.admin;
  await admin.execute(
    `update public.person_logins set active = false, deactivated_at = now()
      where person_id = any($1::uuid[]) and active`,
    [others],
  );
  try {
    const listed = await w.world.db.app.withBusiness(
      w.world.business,
      async (tx) => await readUnattended(tx, w.q.personId),
    );
    const ids = new Set(listed.map((item) => item.id));
    return items.every((item) => ids.has(item.id));
  } finally {
    await admin.execute(
      `update public.person_logins set active = true, deactivated_at = null
        where person_id = any($1::uuid[]) and not active`,
      [others],
    );
  }
}

describe.skipIf(serverUrl === undefined)('decision items: an agent assignee is its person', () => {
  it('assigning AI before proposal removes its delegating person from decision recipients', async () => {
    const task = await created(w, w.p, 'AI first, then the proposal');
    expect(codeOf(await assign(w, w.p, task, { agent: await minted(w, w.p, task) }))).toBe(
      'not-a-refusal',
    );
    const gate = await proposed(task);
    expect(codeOf(await decide(w.p, gate))).toBe('FOUR_EYES_REQUIRED');
    const recipients = (await openItems(gate)).map((item) => item.person);
    expect(recipients).toContain(w.q.personId);
    expect(recipients).not.toContain(w.p.personId);
  });

  it('assigning AI after proposal removes its delegating person from decision recipients', async () => {
    const task = await created(w, w.p, 'The proposal, then AI');
    const gate = await proposed(task);
    expect((await openItems(gate)).map((item) => item.person)).toContain(w.p.personId);
    expect(codeOf(await assign(w, w.p, task, { agent: await minted(w, w.p, task) }))).toBe(
      'not-a-refusal',
    );
    expect(codeOf(await decide(w.p, gate))).toBe('FOUR_EYES_REQUIRED');
    const recipients = (await openItems(gate)).map((item) => item.person);
    expect(recipients).toContain(w.q.personId);
    expect(recipients).not.toContain(w.p.personId);
  });
});

describe.skipIf(serverUrl === undefined)('unattended: only a path decide admits', () => {
  it('an item held by the person whose agent holds the task is no path to its decision', async () => {
    const task = await created(w, w.p, 'An item left with the agent’s person');
    const gate = await proposed(task);
    // The agent set on the row alone, as no command sets it, so the item P
    // was raised stays open and the read's own rule is what is asked.
    await w.world.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('agent', $2::text) where id = $1`,
      [task, await minted(w, w.p, task)],
    );
    expect(codeOf(await decide(w.p, gate))).toBe('FOUR_EYES_REQUIRED');
    expect(await unattendedWithOnly(gate, w.p.personId)).toBe(true);
  });

  it('a party-only decide grant is not a path to a gate the runtime refuses', async () => {
    const holder = await w.world.decider(`party-${randomUUID().slice(0, 8)}`);
    const clientId = randomUUID();
    await addClient(w.world.db.app, w.world.business, clientId, w.p);
    const task = await created(w, w.p, 'A task on a client');
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, w.p, 'share');
    });
    const party = await w.world.asPerson(w.p, {
      command: 'task.set_party',
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: await revisionOf(w, task),
      fields: { client: clientId },
    });
    expect(codeOf(party)).toBe('not-a-refusal');
    const gate = await proposed(task);
    // The holder's decide narrows to the task's client alone.
    await w.world.revokeGrant(holder.grants.decide);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, holder, 'decide', { kind: 'party', id: clientId });
    });
    expect(codeOf(await decide(holder, gate))).toBe('SCOPE_NOT_GRANTED');
    expect(await unattendedWithOnly(gate, holder.personId)).toBe(true);
  });
});
