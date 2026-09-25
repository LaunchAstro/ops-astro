// SPDX-License-Identifier: AGPL-3.0-only
//
// L6 G05: the seven-day server maximum on `task.restart`'s gate, through the
// route.
//
// Owner decision, 23 September 2026: "Fixed server maximum of seven days
// (Recommended)" for new proposals and successor gates. A restart opens a new
// lineage with a new gate, and `restartOnTask` reads its `expiresInSeconds`
// through the same `expiryFrom` (`tasks-controls.ts:129`). `expiry-bound.test.ts`
// covers `task.propose` and the handback successor; this is the third path.
// 604800 is accepted; 604801 is refused `FIELD_VALUE_INVALID`, audited, and
// opens no lineage.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { createControls, detailOf, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const SEVEN_DAYS = 604_800;

describe.skipIf(serverUrl === undefined)('the seven-day maximum on a restart gate', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('rstbd');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  /** A task whose one proposal was rejected: a terminal lineage a restart may continue. */
  async function rejectedLineage(title: string): Promise<{ taskId: string; lineageId: string }> {
    const task = await c.createTask(title);
    const proposal = await c.propose(task.id, task.revision, 'restart_me');
    const rejected = await c.asPerson('task.decide', {
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'reject',
      note: 'not this',
    });
    expect(rejected.status).toBe(200);
    return { taskId: task.id, lineageId: String(proposal['lineageId']) };
  }

  const children = async (lineageId: string): Promise<number> =>
    await c.count(
      `select count(*)::text as n from public.proposal_lineages where restarts_lineage_id = $1`,
      [lineageId],
    );

  it('refuses one second past seven days, audited, and opens no lineage', async () => {
    const { taskId, lineageId } = await rejectedLineage('a restart that asks for too long');
    const operationId = `restart-too-long-${taskId}`;
    const answer = await c.asPerson('task.restart', {
      operationId,
      recordId: taskId,
      lineageId,
      expiresInSeconds: SEVEN_DAYS + 1,
    });
    expect(answer.status).toBe(422);
    expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
    expect(answer.body['names']).toStrictEqual(['expiresInSeconds']);
    expect(JSON.stringify(answer.body['fixes'])).toContain('604800');
    expect(
      await c.count(
        `select count(*)::text as n from public.audit_events
          where command = 'task.restart' and operation_id = $1`,
        [operationId],
      ),
    ).toBe(1);
    expect(
      await c.count(
        `select count(*)::text as n from public.audit_events
          where command = 'task.restart' and operation_id = $1 and outcome = 'refused'
            and refusal_code = 'FIELD_VALUE_INVALID'`,
        [operationId],
      ),
    ).toBe(1);
    expect(await children(lineageId)).toBe(0);
    expect(
      await c.count(`select count(*)::text as n from public.proposal_lineages where task_id = $1`, [
        taskId,
      ]),
    ).toBe(1);
    expect(
      await c.count(
        `select count(*)::text as n from public.proposal_lineages where id = $1 and state = 'rejected'`,
        [lineageId],
      ),
    ).toBe(1);
  });

  it('accepts exactly seven days, and the new gate closes seven days out', async () => {
    const { taskId, lineageId } = await rejectedLineage('a restart open for the full week');
    const answer = await c.asPerson('task.restart', {
      recordId: taskId,
      lineageId,
      expiresInSeconds: SEVEN_DAYS,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(detailOf(answer)['restartsLineageId']).toBe(lineageId);
    expect(await children(lineageId)).toBe(1);
    expect(
      await c.count(
        `select count(*)::text as n from public.gates
          where id = $1 and expires_at between now() + interval '6 days 23 hours'
                                           and now() + interval '7 days'`,
        [detailOf(answer)['gateId']],
      ),
    ).toBe(1);
  });
});
