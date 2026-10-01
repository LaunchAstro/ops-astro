// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-08 isolation`: the launch gate reads only the caller's own business.
// Three crossings, statuses checked, a stored canary (the task's title) absent
// from every refusal: another business (its sign-off setting never holds this
// one, and its lease is not this one's to dispatch); another client in the
// same business (a client of another task cannot dispatch this one's work);
// another person's agent under its own live delegation (its credential cannot
// dispatch this person's lease). Each with a positive control.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { cq8World } from './cq-8-world.ts';
import { noDatabase, useAw04World, w } from './aw-04-world.ts';
import { codeOf, rows } from './schedules-harness.ts';
import { dispatchAs, leased, marked, otherPerson, setSignOff } from './aw-08-gate-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw04World('aw08iso');

it('AW-08 isolation: another business: its sign-off never holds this one, and its lease is not this one’s', async () => {
  const canary = `aw08-iso-alpha-${randomUUID()}`;
  const alpha = await leased(w.alpha, 'launch', canary);
  const bravo = await leased(w.bravo, 'launch');
  await setSignOff(w.alpha, true);
  try {
    // Bravo's agent presenting alpha's lease in bravo: no such lease there.
    const crossed = await dispatchAs(w.bravo, alpha, bravo.credential);
    expect(codeOf(crossed)).toBe('LEASE_NOT_OWNED');
    expect(JSON.stringify(crossed)).not.toContain(canary);
    expect(JSON.stringify(crossed)).not.toContain(alpha.taskId);
    expect(await marked(w.alpha, alpha.taskId)).toBe(0);
    // Control: alpha's own setting holds alpha; bravo's work dispatches.
    expect(codeOf(await dispatchAs(w.alpha, alpha))).toBe('CLIENT_SIGNOFF_REQUIRED');
    expect(codeOf(await dispatchAs(w.bravo, bravo))).toBe('applied');
  } finally {
    await setSignOff(w.alpha, false);
  }
});

it('AW-08 isolation: another client in the same business cannot dispatch this task’s work', async () => {
  const canary = `aw08-iso-one-${randomUUID()}`;
  const one = await leased(w.alpha, 'launch', canary);
  const two = await leased(w.alpha, 'launch');
  await w.alpha.db.app.withBusiness(w.alpha.business, async (tx) => {
    await grantTo(tx, w.alpha.decider, 'share');
  });
  const client = await cq8World(w.alpha).client(
    w.alpha.business,
    w.alpha.decider,
    'aw08c',
    two.taskId,
  );
  const crossed = await executeCommand(w.alpha.db.app, w.alpha.business, client.presented, 'api', {
    command: 'task.dispatch',
    operationId: randomUUID(),
    leaseId: one.picked['leaseId'],
    fence: one.picked['fence'],
  } as never);
  expect(codeOf(crossed)).toBe('SCOPE_NOT_GRANTED');
  expect(JSON.stringify(crossed)).not.toContain(canary);
  expect(JSON.stringify(crossed)).not.toContain(one.taskId);
  expect(await marked(w.alpha, one.taskId)).toBe(0);
  // Control: the task's own agent dispatches it.
  expect(codeOf(await dispatchAs(w.alpha, one))).toBe('applied');
});

it('AW-08 isolation: another person’s agent, under its own live delegation, cannot dispatch this lease', async () => {
  const canary = `aw08-iso-mine-${randomUUID()}`;
  const mine = await leased(w.alpha, 'launch', canary);
  const them = await otherPerson(w.alpha, 'aw08-other');
  const theirs = await leased(them, 'launch');
  const live = await rows<{ live: boolean; person: string }>(
    w.alpha,
    `select (d.revoked_at is null and d.settled_at is null and d.expires_at > now()) as live,
            d.delegate_person_id as person
       from public.leases l join public.delegations d
         on d.business_id = l.business_id and d.id = l.delegation_id
      where l.business_id = $1 and l.id = $2`,
    [w.alpha.business, theirs.picked['leaseId']],
  );
  expect({ ...live[0] }).toEqual({ live: true, person: them.decider.personId });
  const crossed = await dispatchAs(them, mine, theirs.credential);
  // Their delegation is scoped to their own task, so the agent entry refuses
  // before dispatch, naming only that scope.
  expect(codeOf(crossed)).toBe('DELEGATION_OUT_OF_PURPOSE');
  expect(JSON.stringify(crossed)).not.toContain(canary);
  expect(JSON.stringify(crossed)).not.toContain(mine.taskId);
  expect(await marked(w.alpha, mine.taskId)).toBe(0);
  // Controls: each agent dispatches its own person's work.
  expect(codeOf(await dispatchAs(them, theirs))).toBe('applied');
  expect(codeOf(await dispatchAs(w.alpha, mine))).toBe('applied');
});
