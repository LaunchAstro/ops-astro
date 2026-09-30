// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04 isolation: the plan accept across the three crossings. Another
// business's gate, a same-business task outside the caller's own client
// grant, and another person's agent under its own live delegation reaching
// for this run's pinned file: each is refused with its status, writes nothing,
// and never carries the crossed task's canary title or ids out in its body.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { enrol, grantTo } from '../commands/fixture.ts';
import { anotherPersonsAgent, ENTRY, fingerprint, readAs } from './aw-02-world.ts';
import {
  acceptAs,
  acceptRequest,
  gateOf,
  noDatabase,
  pinsOf,
  proposed,
  useAw04World,
  w,
} from './aw-04-world.ts';
import { createTask, freshPurpose, propose } from './schedules-harness.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw04World('aw04_iso');

const canary = (): string => `aw04-canary-${randomUUID()}`;

it('AW-04 isolation: another business: accepting its gate is NOT_FOUND-shaped, pins nothing and carries nothing out', async () => {
  const title = canary();
  const plan = await proposed(w.alpha, title);
  const before = await fingerprint(w.alpha);
  // Bravo's decider, in bravo's business, names alpha's gate and version.
  const crossed = await acceptAs(w.bravo, {
    ...acceptRequest(w.bravo, plan),
    gateId: String(plan.proposal['gateId']),
  });
  expect(crossed.ok).toBe(false);
  if (crossed.ok) return;
  expect(crossed.refusal.code).toBe('GATE_NOT_FOUND');
  const body = JSON.stringify(crossed);
  for (const foreign of [title, plan.taskId, String(plan.proposal['runId'])]) {
    expect(body).not.toContain(foreign);
  }
  expect(await fingerprint(w.alpha)).toBe(before);
  expect(await pinsOf(w.alpha, plan.proposal['runId'])).toEqual([]);
  expect((await gateOf(w.alpha, plan.proposal['gateId'])).state).toBe('pending');
  // Control: alpha's own decider accepts it.
  expect((await acceptAs(w.alpha, acceptRequest(w.alpha, plan))).ok).toBe(true);
});

it("AW-04 isolation: another client in the same business: decide on its own task only, never the other client's", async () => {
  const ownTask = await createTask(w.alpha, 'aw04 client X task');
  const otherTitle = canary();
  const other = await proposed(w.alpha, otherTitle);
  const client = await enrol(w.alpha.db.app, w.alpha.business, `aw04-client-${randomUUID()}`);
  await w.alpha.db.app.withBusiness(w.alpha.business, async (tx) => {
    await grantTo(tx, client, 'decide', { kind: 'record', id: ownTask });
  });
  const crossed = await acceptAs(w.alpha, acceptRequest(w.alpha, other, client));
  expect(crossed.ok).toBe(false);
  if (crossed.ok) return;
  expect(crossed.refusal.code).toBe('SCOPE_NOT_GRANTED');
  const body = JSON.stringify(crossed);
  for (const foreign of [otherTitle, other.taskId, String(other.proposal['runId'])]) {
    expect(body).not.toContain(foreign);
  }
  expect(await pinsOf(w.alpha, other.proposal['runId'])).toEqual([]);
  expect((await gateOf(w.alpha, other.proposal['gateId'])).state).toBe('pending');
  // Control: the client accepts the plan on its own task.
  const own = {
    taskId: ownTask,
    proposal: await propose(w.alpha, ownTask, { maximumMinor: 1_000, purpose: freshPurpose() }),
  };
  const accepted = await acceptAs(w.alpha, acceptRequest(w.alpha, own, client));
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
});

it("AW-04 isolation: another person under a live delegation: its agent cannot read this run's pinned file with its own lease", async () => {
  const plan = await proposed(w.alpha, canary());
  const accepted = await acceptAs(w.alpha, acceptRequest(w.alpha, plan));
  if (!accepted.ok) throw new Error(`accept refused ${accepted.refusal.code}`);
  const intruder = await anotherPersonsAgent(w.alpha);
  const before = await fingerprint(w.alpha);
  const answer = await readAs(
    w.alpha,
    {
      leaseId: intruder.leaseId,
      holderActorId: intruder.holder_actor_id,
      runId: accepted.value.runId,
      stepId: null,
      path: ENTRY,
    },
    [],
  );
  expect(answer).toContain('LEASE_NOT_OWNED');
  expect(answer).not.toContain(accepted.value.runId);
  expect(await fingerprint(w.alpha)).toBe(before);
  // Control: the intruder's own run is not this one.
  expect(intruder.run_id).not.toBe(accepted.value.runId);
});
