// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-09 with AW-08: the agent's revision after requested changes is its
// output, so it is the reviewed output, and approving it is the launch (lead's
// ruling on N9-M2). The same revision loop holds: two rounds, then approve,
// reject or escalate (`aw-09-round-rules`). A person's own revision on the
// agent's lineage is not the agent's output, so it is never marked and its
// approval stays a plan accept, `LAUNCH_NOT_DECIDED` at dispatch.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isReviewedOutput } from '../../packages/core-runtime/src/reviewed-output.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentOutput, type AgentOutput } from './aw-09-agent-round.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  freshPurpose,
  openSchedules,
  pickup,
  proposeBody,
  revisionOf,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { decideBody } from './t3a-support.ts';

const serverUrl = databaseUrlFromEnvironment();
const EFFECT = { kind: 'synthetic_comment', payload: {} } as const;

// eslint-disable-next-line max-lines-per-function -- two checklist lines over one world
describe.skipIf(serverUrl === undefined)('AW-09 the agent’s revision is its output', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('aw09_revision', 1_000_000);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  /** The agent's output with changes requested on it: the round the revision answers. */
  const changesAsked = async (): Promise<AgentOutput> => {
    const { output } = await agentOutput(s, undefined, EFFECT);
    expect(codeOf(await asPerson(s, decideBody({ ...output }, 'request_changes')))).toBe('applied');
    return output;
  };

  /** A revision on the output's lineage, by the agent (its delegation) or by the person. */
  const revisedBy = async (output: AgentOutput, who: 'agent' | 'person'): Promise<Detail> => {
    const body = {
      ...proposeBody(output.taskId, await revisionOf(s, output.taskId), {
        purpose: freshPurpose(),
        maximumMinor: 1_000,
        lineageId: output.lineageId,
      }),
      step: EFFECT,
    };
    const result =
      who === 'agent' ? await asAgent(s, body, output.delegation) : await asPerson(s, body);
    return appliedDetail(result, `${who} revision`);
  };

  const reviewed = async (versionId: unknown): Promise<boolean> =>
    await s.db.app.withBusiness(s.business, (tx) => isReviewedOutput(tx, String(versionId)));

  /** The lease a mark names, for `versionId`. */
  const markLease = async (versionId: unknown) =>
    await rows<{ readonly lease_id: string }>(
      s,
      `select lease_id from public.reviewed_outputs where business_id = $1 and version_id = $2`,
      [s.business, versionId],
    );

  const dispatched = async (version: Detail) => {
    const approved = appliedDetail(await asPerson(s, decideBody(version, 'approve')), 'approve');
    const lease = await pickup(s, approved['reservationId']);
    const body = {
      command: 'task.dispatch',
      operationId: randomUUID(),
      leaseId: lease['leaseId'],
      fence: lease['fence'],
    };
    return await asAgent(s, body, String(lease['credential']));
  };

  it('the agent’s revision after requested changes is the reviewed output', async () => {
    const output = await changesAsked();
    const revision = await revisedBy(output, 'agent');
    expect(await reviewed(revision['versionId'])).toBe(true);
    // Marked under the lease whose hand-back made the output it revises.
    expect(await markLease(revision['versionId'])).toEqual(await markLease(output.versionId));

    // Its revision in the next round is the reviewed output too.
    expect(codeOf(await asPerson(s, decideBody(revision, 'request_changes')))).toBe('applied');
    const second = await revisedBy(output, 'agent');
    expect(await reviewed(second['versionId'])).toBe(true);

    // Control: a person's own revision on the agent's lineage is not the agent's output.
    const other = await changesAsked();
    const own = await revisedBy(other, 'person');
    expect(await reviewed(own['versionId'])).toBe(false);
  });

  it('approving the revision is the launch; dispatch before it is LAUNCH_NOT_DECIDED', async () => {
    // Before the launch: a person's own revision, approved, is a plan accept.
    const other = await changesAsked();
    expect(codeOf(await dispatched(await revisedBy(other, 'person')))).toBe('LAUNCH_NOT_DECIDED');

    const output = await changesAsked();
    expect(codeOf(await dispatched(await revisedBy(output, 'agent')))).toBe('applied');
  });
});
