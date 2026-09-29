// SPDX-License-Identifier: AGPL-3.0-only
//
// T3a, escalate at the revision bound, and the two register codes that
// replace `VERSION_SUPERSEDED` and `PROPOSAL_OUT_OF_SCOPE`, over a real
// database through the command entry and, where the approver's role and the
// escalation role differ, the runtime's own decide.
//
// The escalation role is the gate's own authority one scope wider: a holder
// of `decide` at business scope (orchestrator decision on #153). Escalate is
// offered only once the two rounds of changes are used; it records the actor
// and the recipient on the gate, leaves the gate open and writes no decision;
// from then on only a business-scope decider decides it. A recipient outside
// the role, or nobody at all, fails closed and leaves approve and reject
// performable. Escalate replays by operation identifier.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { decide, gateSigningKey } from '../../packages/core-runtime/src/index.ts';
import type { EntryPoint } from '../../packages/core-records/src/tasks/placement.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  createTask,
  openSchedules,
  propose,
  revisionOf,
  rows,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { PRICED, t2dHarness } from './t2d-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t3a-escalate: DATABASE_URL is unset, so nothing below ran.');
}

const decideBody = (version: Detail, decision: string, extra: Body = {}): Body => ({
  command: 'task.decide',
  operationId: randomUUID(),
  gateId: version['gateId'],
  versionId: version['versionId'],
  decision,
  note: `${decision} in the T3a escalation cases`,
  ...extra,
});

describe.skipIf(serverUrl === undefined)('T3a escalate at the bound', () => {
  let s: Schedules;
  let holder: Member;
  const { work, applied, observeOf } = t2dHarness(() => s);

  beforeAll(async () => {
    s = await openSchedules('t3a_escalate', 1_000_000);
    // The escalation role: decide at business scope, held by a second person.
    holder = await enrol(s.db.app, s.business, 'escalation-holder');
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const action of ['read', 'decide'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, holder, action);
      }
    });
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  const as = async (member: Member, body: Body, surface: EntryPoint = 'api') =>
    await executeCommand(s.db.app, s.business, member.presented, surface, body as never);

  /** A person holding read, write and decide on exactly one task: the approver's role. */
  async function approverOn(taskId: string): Promise<Member> {
    const member = await enrol(s.db.app, s.business, `approver-${randomUUID()}`);
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const action of ['read', 'write', 'decide'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, member, action, { kind: 'record', id: taskId });
      }
    });
    return member;
  }

  /** A task whose third version's gate is at the bound: two rounds of changes used. */
  async function atTheBound() {
    const taskId = await createTask(s, `t3a escalate ${randomUUID()}`);
    const approver = await approverOn(taskId);
    const v1 = await propose(s, taskId);
    appliedDetail(await asPerson(s, decideBody(v1, 'request_changes')), 'round 1');
    const v2 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
    appliedDetail(await asPerson(s, decideBody(v2, 'request_changes')), 'round 2');
    const v3 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
    expect(codeOf(await asPerson(s, decideBody(v3, 'request_changes')))).toBe(
      'CHANGE_ROUNDS_EXHAUSTED',
    );
    return { taskId, v3, approver };
  }

  /**
   * The runtime's own decide, as the record-scoped approver. The command
   * entry asks decide at business scope before it; the runtime asks it on the
   * task, which is where the approver's role and the escalation role differ.
   */
  async function decidesAsApprover(
    approver: Member,
    version: Detail,
    decision: 'approve' | 'reject',
  ): Promise<string> {
    const signingKey = gateSigningKey();
    if (signingKey === undefined) throw new Error('no signing key in the fixture');
    const result = await s.db.app.withBusiness(
      s.business,
      async (tx) =>
        await decide(tx, {
          gateId: String(version['gateId']),
          versionId: String(version['versionId']),
          decidedByPersonId: approver.personId,
          decidedByActorId: approver.actorId,
          subjects: [
            { kind: 'person', id: approver.personId },
            { kind: 'actor', id: approver.actorId },
          ],
          collection: 'task',
          decision,
          note: 'the approver deciding',
          signingKey,
          capId: s.capId,
        }),
    );
    return result.ok ? 'applied' : result.refusal.code;
  }

  async function gateOf(gateId: unknown) {
    return (
      await rows<Record<string, unknown>>(
        s,
        `select g.state, g.escalated_to_person_id as "to", g.escalated_by_person_id as "by",
                (g.escalated_at is not null) as escalated,
                (select count(*)::int from public.gate_decisions d
                  where d.business_id = g.business_id and d.gate_id = g.id) as decisions
           from public.gates g where g.business_id = $1 and g.id = $2`,
        [s.business, gateId],
      )
    )[0];
  }

  it('moves the decision to a business-scope decider, records actor and recipient, and decides nothing', async () => {
    const { v3, approver } = await atTheBound();
    const escalated = appliedDetail(
      await asPerson(s, decideBody(v3, 'escalate', { recipientPersonId: holder.personId })),
      'escalate',
    );
    expect(escalated).toMatchObject({
      decision: 'escalate',
      gateId: v3['gateId'],
      escalatedToPersonId: holder.personId,
    });
    expect(await gateOf(v3['gateId'])).toEqual({
      state: 'pending',
      to: holder.personId,
      by: s.decider.personId,
      escalated: true,
      decisions: 0,
    });

    // The approver's decide on the task no longer reaches this gate.
    expect(await decidesAsApprover(approver, v3, 'approve')).toBe('SCOPE_NOT_GRANTED');
    expect(await decidesAsApprover(approver, v3, 'reject')).toBe('SCOPE_NOT_GRANTED');
    expect(await gateOf(v3['gateId'])).toMatchObject({ state: 'pending', decisions: 0 });
    // A holder of the escalation role decides it.
    expect(codeOf(await as(holder, decideBody(v3, 'reject')))).toBe('applied');
    expect(await gateOf(v3['gateId'])).toMatchObject({ state: 'rejected', decisions: 1 });
  });

  it('refuses an approver outside the escalation role, or nobody, as recipient, and leaves approve and reject performable', async () => {
    const { v3, approver } = await atTheBound();
    for (const recipientPersonId of [approver.personId, randomUUID()]) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await asPerson(s, decideBody(v3, 'escalate', { recipientPersonId }));
      expect(codeOf(refused)).toBe('SCOPE_NOT_GRANTED');
      expect(isCommandRefusal(refused) ? refused.names : []).toContain('recipientPersonId');
      expect(JSON.stringify(refused)).not.toContain(recipientPersonId);
    }
    expect(codeOf(await asPerson(s, decideBody(v3, 'escalate')))).toBe('FIELD_VALUE_INVALID');
    expect(await gateOf(v3['gateId'])).toMatchObject({ state: 'pending', escalated: false });
    // Approve and reject stay performable: the approver's decide still reaches it.
    expect(await decidesAsApprover(approver, v3, 'approve')).toBe('applied');
  });

  it('is not offered before the bound, and a recipient on another decision is refused', async () => {
    const taskId = await createTask(s, `t3a early ${randomUUID()}`);
    const v1 = await propose(s, taskId);
    const early = await asPerson(
      s,
      decideBody(v1, 'escalate', { recipientPersonId: holder.personId }),
    );
    expect(codeOf(early)).toBe('TRANSITION_NOT_PERMITTED');
    expect(
      codeOf(await asPerson(s, decideBody(v1, 'approve', { recipientPersonId: holder.personId }))),
    ).toBe('FIELD_VALUE_INVALID');
    expect(await gateOf(v1['gateId'])).toMatchObject({ state: 'pending', escalated: false });
  });

  it('approve refuses a carried null escalation recipient', async () => {
    const taskId = await createTask(s, `t3a null recipient ${randomUUID()}`);
    const v1 = await propose(s, taskId);
    const attempted = await asPerson(s, decideBody(v1, 'approve', { recipientPersonId: null }));
    expect(codeOf(attempted)).toBe('FIELD_VALUE_INVALID');
    expect(await gateOf(v1['gateId'])).toMatchObject({ state: 'pending', decisions: 0 });
  });

  it('a task-scoped decider can approve at the bound before escalation', async () => {
    const { v3, approver } = await atTheBound();
    expect(codeOf(await as(approver, decideBody(v3, 'approve')))).toBe('applied');
  });

  it('replays by operation identifier, and is refused to an agent and to a person without decide on every surface', async () => {
    const { taskId, v3 } = await atTheBound();
    const body = decideBody(v3, 'escalate', { recipientPersonId: holder.personId });
    const first = appliedDetail(await asPerson(s, body), 'escalate');
    const again = appliedDetail(await asPerson(s, body), 'escalate replayed');
    expect(again).toStrictEqual(first);

    const noDecide = await enrol(s.db.app, s.business, `no-decide-${randomUUID()}`);
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const action of ['read', 'write'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, noDecide, action, { kind: 'record', id: taskId });
      }
    });
    const before = await gateOf(v3['gateId']);
    const escalate = () => decideBody(v3, 'escalate', { recipientPersonId: holder.personId });
    for (const surface of ['app', 'api', 'cli'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const code = codeOf(await as(noDecide, escalate(), surface));
      expect({ surface, code }).toEqual({ surface, code: 'SCOPE_NOT_GRANTED' });
    }
    const w = await work();
    expect(codeOf(await asAgent(s, escalate(), w.credential))).not.toBe('applied');
    expect(await gateOf(v3['gateId'])).toEqual(before);
  });

  it('answers PROPOSAL_SUPERSEDED for a superseded version and PROPOSAL_SCOPE_EXCEEDED past the envelope', async () => {
    const taskId = await createTask(s, `t3a codes ${randomUUID()}`);
    const v1 = await propose(s, taskId);
    await propose(s, taskId, { lineageId: String(v1['lineageId']) });
    expect(codeOf(await asPerson(s, decideBody(v1, 'approve')))).toBe('PROPOSAL_SUPERSEDED');

    // A revision on settled work past what the envelope has left (1800 of 2500 spent).
    const w = await work();
    await applied(w);
    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    const past = await asPerson(s, {
      command: 'task.propose',
      operationId: randomUUID(),
      recordId: w.taskId,
      expectedRevision: await revisionOf(s, w.taskId),
      lineageId: w.proposal['lineageId'],
      purpose: 'draft_the_reply',
      maximumMinor: 2_000,
      currency: 'AUD',
      payload: { instruction: 'more than the envelope has left' },
      step: { kind: 'compose', payload: {} },
    });
    expect(codeOf(past)).toBe('PROPOSAL_SCOPE_EXCEEDED');
  });
});
