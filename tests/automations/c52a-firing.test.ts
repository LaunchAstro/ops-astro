// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A: firing under a standing approval, against a real database (U36, #484). An adoption is a person pinning an
// exact released version and approving it for every later occurrence; the claim records the approval it saw, and
// dispatch rechecks it under the activation's lock, so a revoke or a turn-off between the two starts nothing. The
// pins and the isolation are in `c52a-pins.test.ts`; the commands, their refusals and the audit are the next
// increment.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listApprovals,
  readActivation,
  readStandingApproval,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { firingOf, occurrenceOf, runFootprint, starter, type Firing } from './firing.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C52-A firing', () => {
  let w: AutomationWorld;
  let f: Firing;

  beforeAll(async () => {
    w = await createAutomationWorld('c52f');
    f = firingOf(w);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  const runsFor = async (occurrenceId: string): Promise<number> =>
    await w.count('select count(*) as n from public.planned_runs where origin_occurrence_id = $1', [
      occurrenceId,
    ]);

  it('C52-A approved occurrence starts one run: on the exact pinned version, one occurrence starts one run', async () => {
    const { version, activation, approval } = await f.approved();
    expect(approval).toMatchObject({ versionId: version.id, act: 'adopted', revoked: false });
    const occurrence = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    expect(occurrence).toMatchObject({ outcome: 'approved', versionId: version.id });
    const s = starter(w.worker);
    const sent = await f.dispatch(occurrence.id, s.start);
    expect(sent.kind).toBe('dispatched');
    expect(s.runs).toEqual([
      { occurrenceId: occurrence.id, activationId: activation.id, versionId: version.id },
    ]);
    expect(sent.kind === 'dispatched' && sent.dispatch.outcome).toBe('started');
    expect(sent.kind === 'dispatched' && typeof sent.dispatch.runId).toBe('string');
    expect(await f.started(activation.id)).toBe(1);
  });

  it('C52-A revoked approval stops runs: after a revoke the next occurrence starts none and records why', async () => {
    const { activation, approval } = await f.approved();
    expect(await f.revoke(approval.id)).toBe('revoked');
    expect(await f.revoke(approval.id)).toBe('already_revoked');
    const occurrence = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    expect(occurrence.outcome).toBe('no_standing_approval');
    const s = starter(w.worker);
    expect(await f.dispatch(occurrence.id, s.start)).toEqual({
      kind: 'not_approved',
      outcome: 'no_standing_approval',
    });
    expect(s.runs).toEqual([]);
    expect(await f.started(activation.id)).toBe(0);
    // The revoked approval stays in the history, marked, and the pin is where it was.
    const history = await w.inAlpha((tx) => listApprovals(tx, activation.id));
    expect(history).toMatchObject([{ id: approval.id, revoked: true }]);
    expect((await w.inAlpha((tx) => readActivation(tx, activation.id)))?.versionId).toBe(
      approval.versionId,
    );
  });

  it('C52-A turned off does not fire: after a turn-off the next scheduled occurrence starts none and records why', async () => {
    const { activation } = await f.approved();
    await f.turnOff(activation.id);
    const occurrence = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    expect(occurrence.outcome).toBe('activation_off');
    const s = starter(w.worker);
    expect(await f.dispatch(occurrence.id, s.start)).toEqual({
      kind: 'not_approved',
      outcome: 'activation_off',
    });
    expect(s.runs).toEqual([]);
    // Turning it off ends the standing approval (C27-1): switching it back on is not a run.
    expect(await w.inAlpha((tx) => readStandingApproval(tx, activation.id))).toBeNull();
    expect(await w.inAlpha((tx) => listApprovals(tx, activation.id))).toHaveLength(1);
  });

  it('C52-A revoked before dispatch: an occurrence claimed before a revoke or a turn-off and dispatched after it starts no run', async () => {
    const before = await runFootprint(w);
    const revoked = await f.approved();
    const held = occurrenceOf(await w.claim(revoked.activation.id, { dueAt: f.nextDue() }));
    expect(held.outcome).toBe('approved');
    expect(await f.revoke(revoked.approval.id)).toBe('revoked');
    const s = starter(w.worker);
    const late = await f.dispatch(held.id, s.start);
    expect(late).toEqual({
      kind: 'dispatched',
      dispatch: { occurrenceId: held.id, outcome: 'approval_revoked', runId: null },
    });
    expect(await f.dispatch(held.id, s.start)).toEqual({ ...late, kind: 'replayed' });

    const off = await f.approved();
    const heldOff = occurrenceOf(await w.claim(off.activation.id, { dueAt: f.nextDue() }));
    expect(heldOff.outcome).toBe('approved');
    await f.turnOff(off.activation.id);
    expect(await f.dispatch(heldOff.id, s.start)).toEqual({
      kind: 'dispatched',
      dispatch: { occurrenceId: heldOff.id, outcome: 'activation_off', runId: null },
    });
    expect(s.runs).toEqual([]);
    expect(await runFootprint(w)).toEqual(before);
    expect(await f.started(revoked.activation.id)).toBe(0);
    expect(await f.started(off.activation.id)).toBe(0);
  });

  it('C52-A approved occurrence once, scheduled: a replayed due time and a restarted scheduler end with one occurrence and one run', async () => {
    const { activation } = await f.approved();
    const dueAt = f.nextDue();
    const [a, b] = await Promise.all([
      w.claim(activation.id, { dueAt }),
      w.claim(activation.id, { dueAt }),
    ]);
    // The scheduler restarts and asks for the same due time again.
    const c = await w.claim(activation.id, { dueAt });
    const ids = new Set([a, b, c].map((one) => occurrenceOf(one).id));
    expect(ids.size).toBe(1);
    expect(await w.occurrences(activation.id)).toBe(1);
    const [id] = [...ids] as [string];
    const s = starter(w.worker);
    const sent = await Promise.all([f.dispatch(id, s.start), f.dispatch(id, s.start)]);
    sent.push(await f.dispatch(id, s.start));
    expect(sent.map((one) => one.kind).toSorted()).toEqual(['dispatched', 'replayed', 'replayed']);
    expect(s.runs).toHaveLength(1);
    expect(await runsFor(id)).toBe(1);
    expect(await f.started(activation.id)).toBe(1);
  });

  it('C52-A approved occurrence once, event: an event delivered twice ends with one occurrence and one run', async () => {
    const { activation } = await f.approved('event');
    const eventId = `evt-${randomUUID()}`;
    const [a, b] = await Promise.all([
      w.claim(activation.id, { eventId }),
      w.claim(activation.id, { eventId }),
    ]);
    expect(occurrenceOf(a).id).toBe(occurrenceOf(b).id);
    const s = starter(w.worker);
    const sent = await Promise.all([
      f.dispatch(occurrenceOf(a).id, s.start),
      f.dispatch(occurrenceOf(b).id, s.start),
    ]);
    expect(sent.map((one) => one.kind).toSorted()).toEqual(['dispatched', 'replayed']);
    expect(s.runs).toHaveLength(1);
    expect(await runsFor(occurrenceOf(a).id)).toBe(1);
    expect(await w.occurrences(activation.id)).toBe(1);
    expect(await f.started(activation.id)).toBe(1);
  });
});
