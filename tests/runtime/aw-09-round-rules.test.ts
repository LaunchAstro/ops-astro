// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-09's supporting checklist for agent output, over a real database through
// the command entry (T3a built the loop; these prove it holds when the version
// under review is the agent's own handed-back output, and the agent revises
// through `task.propose` inside its delegation):
//
// - a superseded version's decision is `PROPOSAL_SUPERSEDED`, and the version
//   that superseded it starts with no approval;
// - an approval given before the agent superseded its version refuses at
//   dispatch (`DECISION_STALE`) and marks nothing, beside a positive control;
// - a revision past the envelope is `PROPOSAL_SCOPE_EXCEEDED`, refused rather
//   than trimmed, and the round count and the work stand;
// - after a reject the lineage takes nothing more (`LINEAGE_TERMINAL`); work
//   restarts only as a new lineage, by the agent's fresh proposal or a
//   person's restart, and the restart's approval takes its own envelope;
// - escalation at the bound goes only to the escalation role, and with nobody
//   in it is refused, routing nothing to the assignee;
// - a reviewer whose session ends mid-decision leaves nothing half-decided:
//   the gate, the round and the inbox item stay open.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  cutProxy,
  openSchedules,
  pickup,
  racer,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { decideBody, restartBody } from './t3a-support.ts';
import { agentOutput, agentProposes, type AgentOutput } from './aw-09-agent-round.ts';

const serverUrl = databaseUrlFromEnvironment();

const at = (output: AgentOutput): Detail => ({ ...output });

// eslint-disable-next-line max-lines-per-function -- five checklist lines over one world
describe.skipIf(serverUrl === undefined)('AW-09 the round over agent output', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('aw09_rules', 1_000_000);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  const gate = async (gateId: unknown) =>
    (
      await rows<{ readonly state: string; readonly round: number; readonly decisions: number }>(
        s,
        `select g.state, g.round, (select count(*)::int from public.gate_decisions d
                                    where d.business_id = g.business_id and d.gate_id = g.id) as decisions
           from public.gates g where g.business_id = $1 and g.id = $2`,
        [s.business, gateId],
      )
    )[0];
  const revised = async (output: AgentOutput): Promise<Detail> =>
    appliedDetail(await agentProposes(s, output, { lineageId: output.lineageId }), 'revision');

  it("a superseded agent version's decision is PROPOSAL_SUPERSEDED, and its successor starts unapproved", async () => {
    const { output } = await agentOutput(s);
    const next = await revised(output);
    expect(codeOf(await asPerson(s, decideBody(at(output), 'approve')))).toBe(
      'PROPOSAL_SUPERSEDED',
    );
    expect(await gate(output.gateId)).toMatchObject({ state: 'superseded', decisions: 0 });
    expect(await gate(next['gateId'])).toMatchObject({ state: 'pending', decisions: 0 });
  });

  const leased = async (output: AgentOutput): Promise<Detail> => {
    const approved = appliedDetail(await asPerson(s, decideBody(at(output), 'approve')), 'approve');
    const reservationId = approved['reservationId'];
    return { ...(await pickup(s, reservationId)), reservationId };
  };
  const dispatched = async (lease: Detail) =>
    await asAgent(
      s,
      {
        command: 'task.dispatch',
        operationId: randomUUID(),
        leaseId: lease['leaseId'],
        fence: lease['fence'],
      },
      String(lease['credential']),
    );
  const marked = async (lease: Detail) =>
    await rows<{ readonly marker: boolean }>(
      s,
      `select dispatch_marker as marker from public.attempts where business_id = $1 and id = $2`,
      [s.business, lease['attemptId']],
    );
  const dispatchable = { kind: 'synthetic_comment', payload: {} };

  it('an approval of an agent version the agent then superseded refuses at dispatch, and marks nothing', async () => {
    // The positive control: an approved agent version nobody superseded dispatches.
    const control = await leased((await agentOutput(s, undefined, dispatchable)).output);
    expect(codeOf(await dispatched(control))).toBe('applied');

    // The agent's own revision supersedes the approved version: the lease and
    // its delegation end with it, so the dispatch is refused before any lock.
    const { output } = await agentOutput(s, undefined, dispatchable);
    const lease = await leased(output);
    const next = await revised(output);
    expect(codeOf(await dispatched(lease))).toBe('DELEGATION_NOT_LIVE');
    expect(await marked(lease)).toEqual([{ marker: false }]);
    expect(await gate(next['gateId'])).toMatchObject({ state: 'pending', decisions: 0 });

    // Under the locks the approval is rechecked too: only the version moved,
    // with the lease still live, is DECISION_STALE.
    const held = await leased((await agentOutput(s, undefined, dispatchable)).output);
    await s.db.admin.execute(
      `update public.proposal_versions set superseded_at = now()
        where business_id = $1 and id = (select version_id from public.reservations
                                          where business_id = $1 and id = $2)`,
      [s.business, held['reservationId']],
    );
    expect(codeOf(await dispatched(held))).toBe('DECISION_STALE');
    expect(await marked(held)).toEqual([{ marker: false }]);
  });

  it('an over-scope agent revision is PROPOSAL_SCOPE_EXCEEDED, not trimmed, and keeps the round count and the work', async () => {
    const { output } = await agentOutput(s);
    expect(codeOf(await asPerson(s, decideBody(at(output), 'request_changes')))).toBe('applied');
    const before = await rows<{ readonly n: number }>(
      s,
      `select count(*)::int as n from public.proposal_versions where business_id = $1 and lineage_id = $2`,
      [s.business, output.lineageId],
    );
    const over = await agentProposes(s, output, {
      lineageId: output.lineageId,
      maximumMinor: 2_000_000,
    });
    expect(codeOf(over)).toBe('PROPOSAL_SCOPE_EXCEEDED');
    expect(
      await rows(
        s,
        `select count(*)::int as n from public.proposal_versions where business_id = $1 and lineage_id = $2`,
        [s.business, output.lineageId],
      ),
    ).toStrictEqual(before);
    expect(await gate(output.gateId)).toMatchObject({ state: 'changes_requested', decisions: 1 });
    const next = await revised(output);
    expect(await gate(next['gateId'])).toMatchObject({ state: 'pending', round: 2 });
  });

  it('after a reject the agent output restarts only as a new lineage, by a fresh proposal or a restart on its own envelope', async () => {
    const { output } = await agentOutput(s);
    expect(codeOf(await asPerson(s, decideBody(at(output), 'reject')))).toBe('applied');
    expect(codeOf(await asPerson(s, decideBody(at(output), 'approve')))).not.toBe('applied');
    expect(codeOf(await agentProposes(s, output, { lineageId: output.lineageId }))).toBe(
      'LINEAGE_TERMINAL',
    );
    const kept = await rows<{ readonly state: string }>(
      s,
      `select l.state from public.proposal_versions v
         join public.proposal_lineages l on l.business_id = v.business_id and l.id = v.lineage_id
        where v.business_id = $1 and v.id = $2`,
      [s.business, output.versionId],
    );
    expect(kept).toEqual([{ state: 'rejected' }]);

    const fresh = appliedDetail(await agentProposes(s, output), 'fresh proposal');
    expect(fresh['lineageId']).not.toBe(output.lineageId);
    expect(await gate(fresh['gateId'])).toMatchObject({ state: 'pending', round: 1 });

    const restarted = appliedDetail(
      await asPerson(s, restartBody(output.taskId, output.lineageId)),
      'restart',
    );
    expect(restarted['restartsLineageId']).toBe(output.lineageId);
    const envelopes = async () =>
      await rows<{ readonly id: string }>(
        s,
        `select id from public.task_envelopes where business_id = $1 and task_id = $2 order by id`,
        [s.business, output.taskId],
      );
    const old = await envelopes();
    const approved = appliedDetail(await asPerson(s, decideBody(restarted, 'approve')), 'approve');
    expect(old.map((one) => one.id)).not.toContain(approved['envelopeId']);
  });

  it('escalation at the bound goes only to the escalation role; with nobody eligible it is refused and nothing moves', async () => {
    const { output } = await agentOutput(s);
    let version: Detail = at(output);
    for (const _ of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop -- each round decides the version before it
      expect(codeOf(await asPerson(s, decideBody(version, 'request_changes')))).toBe('applied');
      // eslint-disable-next-line no-await-in-loop -- the agent revises after each ask
      version = await revised(output);
    }
    expect(codeOf(await asPerson(s, decideBody(version, 'request_changes')))).toBe(
      'CHANGE_ROUNDS_EXHAUSTED',
    );
    // A decider on this task only is outside the escalation role, and an
    // unknown person is in no role at all.
    const taskOnly = await enrol(s.db.app, s.business, `aw09-task-${randomUUID()}`);
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, taskOnly, 'decide', { kind: 'record', id: output.taskId });
    });
    for (const recipientPersonId of [taskOnly.personId, randomUUID()]) {
      // eslint-disable-next-line no-await-in-loop -- one recipient at a time
      const refused = await asPerson(s, { ...decideBody(version, 'escalate'), recipientPersonId });
      expect(codeOf(refused)).not.toBe('applied');
    }
    expect(await gate(version['gateId'])).toMatchObject({ state: 'pending', decisions: 0 });
  });

  it('a reviewer session ending mid-decision leaves nothing half-decided: the gate, the round and the inbox item stay open', async () => {
    const { output } = await agentOutput(s);
    const proxy = await cutProxy(s.db.appUrl, 'before-commit');
    const cut = racer(s, proxy.url);
    try {
      await expect(asPerson(s, decideBody(at(output), 'request_changes'), cut)).rejects.toThrow();
      expect(proxy.cut()).toBe(true);
    } finally {
      await cut.close().catch(() => null);
      await proxy.close();
    }
    expect(await gate(output.gateId)).toMatchObject({ state: 'pending', round: 1, decisions: 0 });
    const inbox = await rows<{ readonly work_state: string }>(
      s,
      `select work_state from public.inbox_items
        where business_id = $1 and fact_kind = 'gate' and fact_id = $2`,
      [s.business, output.gateId],
    );
    expect(inbox.length).toBeGreaterThan(0);
    expect(inbox.every((one) => one.work_state === 'open')).toBe(true);
    // The round is still there to take: the same ask completes it.
    expect(codeOf(await asPerson(s, decideBody(at(output), 'request_changes')))).toBe('applied');
  });
});
